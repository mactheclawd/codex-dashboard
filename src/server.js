import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, appendFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { homedir } from "os";
import readline from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3111;

// --- Persistence ---
const THREADS_DIR = join(homedir(), ".codex-dashboard", "threads");
mkdirSync(THREADS_DIR, { recursive: true });

function threadFilePath(threadId) {
  // sanitize threadId for filesystem
  const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(THREADS_DIR, `${safe}.jsonl`);
}

function threadMetaPath(threadId) {
  const safe = threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(THREADS_DIR, `${safe}.meta.json`);
}

function saveThreadMeta(threadId, meta) {
  writeFileSync(threadMetaPath(threadId), JSON.stringify(meta) + "\n");
}

function loadThreadMeta(threadId) {
  const fp = threadMetaPath(threadId);
  if (!existsSync(fp)) return {};
  try { return JSON.parse(readFileSync(fp, "utf-8")); } catch { return {}; }
}

function appendEvent(threadId, event) {
  const line = JSON.stringify(event) + "\n";
  appendFileSync(threadFilePath(threadId), line);
}

function loadEvents(threadId) {
  const fp = threadFilePath(threadId);
  if (!existsSync(fp)) return [];
  const lines = readFileSync(fp, "utf-8").split("\n").filter(Boolean);
  return lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

function loadAllThreadIds() {
  const files = readdirSync(THREADS_DIR).filter((f) => f.endsWith(".jsonl"));
  return files.map((f) => f.replace(/\.jsonl$/, ""));
}

// --- HTTP server for static files ---
const httpServer = createServer((req, res) => {
  const files = {
    "/": "index.html",
    "/index.html": "index.html",
    "/app.js": "app.js",
    "/style.css": "style.css",
  };
  const types = {
    html: "text/html",
    js: "application/javascript",
    css: "text/css",
  };
  const file = files[req.url];
  if (file) {
    const ext = file.split(".").pop();
    res.writeHead(200, { "Content-Type": types[ext] || "text/plain" });
    res.end(readFileSync(join(__dirname, "../public", file)));
  } else {
    res.writeHead(404);
    res.end("Not found");
  }
});

// --- WebSocket server for browser clients ---
const wss = new WebSocketServer({ server: httpServer });
const browserClients = new Set();

wss.on("connection", (ws) => {
  console.log("[dashboard] Browser client connected");
  browserClients.add(ws);

  // Send thread list and active thread info
  const threadIds = Object.keys(agentState.threads);
  const threadList = threadIds.map((id) => ({
    id,
    createdAt: agentState.threads[id].createdAt,
    title: agentState.threads[id].title || null,
  }));

  ws.send(JSON.stringify({
    type: "init",
    data: {
      connected: agentState.connected,
      activeThreadId: agentState.activeThreadId,
      threads: threadList,
    },
  }));

  // If there's an active thread, send its events
  if (agentState.activeThreadId) {
    const events = loadEvents(agentState.activeThreadId);
    ws.send(JSON.stringify({
      type: "thread-events",
      data: { threadId: agentState.activeThreadId, events },
    }));
  }

  ws.on("close", () => {
    browserClients.delete(ws);
    console.log("[dashboard] Browser client disconnected");
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "prompt" && codexProc && agentState.activeThreadId) {
        const tid = agentState.activeThreadId;
        sendToCodex("turn/start", {
          threadId: tid,
          input: [{ type: "text", text: msg.text }],
        });
        // Set thread title from first prompt
        if (agentState.threads[tid] && !agentState.threads[tid].title) {
          agentState.threads[tid].title = msg.text.length > 50 ? msg.text.slice(0, 50) + "…" : msg.text;
          saveThreadMeta(tid, agentState.threads[tid]);
          broadcast({ type: "thread-title", data: { threadId: tid, title: agentState.threads[tid].title } });
        }
      } else if (msg.type === "new-thread") {
        createNewThread();
      } else if (msg.type === "switch-thread") {
        const threadId = msg.threadId;
        if (agentState.threads[threadId]) {
          agentState.activeThreadId = threadId;
          const events = loadEvents(threadId);
          ws.send(JSON.stringify({
            type: "thread-events",
            data: { threadId, events },
          }));
          broadcast({ type: "active-thread", data: { threadId } });
        }
      } else if (msg.type === "load-thread") {
        // Client requesting events for a specific thread
        const threadId = msg.threadId;
        const events = loadEvents(threadId);
        ws.send(JSON.stringify({
          type: "thread-events",
          data: { threadId, events },
        }));
      }
    } catch (e) {
      console.error("[dashboard] Bad message from browser:", e.message);
    }
  });
});

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const client of browserClients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

// --- Agent state ---
const agentState = {
  connected: false,
  activeThreadId: null,
  activeTurnId: null,
  threads: {},
};

// Load persisted threads on startup
for (const id of loadAllThreadIds()) {
  const meta = loadThreadMeta(id);
  agentState.threads[id] = { id, createdAt: meta.createdAt || null, title: meta.title || null };
}
console.log(`[dashboard] Loaded ${Object.keys(agentState.threads).length} persisted threads`);

function pushEvent(event) {
  // Persist to active thread's JSONL
  if (agentState.activeThreadId) {
    appendEvent(agentState.activeThreadId, { ...event, timestamp: Date.now() });
  }
  broadcast({ type: "event", data: { ...event, timestamp: Date.now() } });
}

// --- Codex app-server via stdio ---
let codexProc = null;
let codexRl = null;
let rpcId = 100;
const pendingRequests = new Map();

function sendToCodex(method, params = {}) {
  const id = rpcId++;
  const msg = { method, id, params };
  const line = JSON.stringify(msg);
  console.log("[codex] →", line);
  codexProc.stdin.write(line + "\n");
  return new Promise((resolve, reject) => {
    pendingRequests.set(id, { resolve, reject });
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error(`RPC timeout: ${method}`));
      }
    }, 30000);
  });
}

function sendNotification(method, params = {}) {
  const msg = { method, params };
  const line = JSON.stringify(msg);
  console.log("[codex] →", line);
  codexProc.stdin.write(line + "\n");
}

async function createNewThread() {
  if (!codexProc || !agentState.connected) return;
  try {
    const threadResult = await sendToCodex("thread/start", {
      model: "gpt-5.3-codex",
    });
    if (threadResult?.thread?.id) {
      const id = threadResult.thread.id;
      const threadInfo = { id, createdAt: Date.now() };
      agentState.threads[id] = threadInfo;
      agentState.activeThreadId = id;
      // Touch the JSONL file so it persists
      appendEvent(id, { method: "thread/created", params: { threadId: id }, timestamp: Date.now() });
      console.log(`[codex] New thread: ${id}`);
      broadcast({ type: "new-thread", data: threadInfo });
      broadcast({ type: "active-thread", data: { threadId: id } });
    }
  } catch (e) {
    console.error("[codex] Failed to create thread:", e.message);
  }
}

function startCodex() {
  console.log("[codex] Spawning app-server (stdio)...");

  codexProc = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  codexRl = readline.createInterface({ input: codexProc.stdout });

  codexProc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.log("[codex stderr]", text);
  });

  codexRl.on("line", (line) => {
    console.log("[codex] ←", line);
    try {
      const msg = JSON.parse(line);

      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { resolve, reject } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }

      if (msg.method) {
        handleNotification(msg.method, msg.params || {});
      }
    } catch (e) {
      console.error("[codex] Parse error:", e.message, "line:", line);
    }
  });

  codexProc.on("close", (code) => {
    console.log(`[codex] Process exited with code ${code}`);
    agentState.connected = false;
    broadcast({ type: "status", data: { connected: false } });
    setTimeout(startCodex, 3000);
  });

  // Initialize handshake — but don't auto-create a thread
  setTimeout(async () => {
    try {
      const result = await sendToCodex("initialize", {
        clientInfo: {
          name: "codex_dashboard",
          title: "Codex Dashboard",
          version: "0.2.0",
        },
      });
      console.log("[codex] Initialize result:", JSON.stringify(result));

      sendNotification("initialized");
      console.log("[codex] Handshake complete");

      agentState.connected = true;
      broadcast({ type: "status", data: { connected: true } });

      // Always create a fresh thread on startup (old threads are history-only)
      await createNewThread();
    } catch (e) {
      console.error("[codex] Handshake failed:", e.message);
    }
  }, 500);
}

function handleNotification(method, params) {
  if (method.startsWith("codex/event/")) return;
  if (method === "account/rateLimits/updated") return;
  if (method === "thread/tokenUsage/updated") return;

  const event = { method, params };
  pushEvent(event);

  switch (method) {
    case "turn/started":
      agentState.activeTurnId = params.turn?.id;
      break;
    case "turn/completed":
    case "turn/failed":
      agentState.activeTurnId = null;
      break;
  }

  broadcast({ type: "notification", data: event });
}

// --- Start ---
httpServer.listen(PORT, () => {
  console.log(`[dashboard] UI at http://localhost:${PORT}`);
  startCodex();
});
