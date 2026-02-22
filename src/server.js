import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import readline from "readline";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3111;

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

  // Send current state
  ws.send(JSON.stringify({ type: "state", data: agentState }));

  ws.on("close", () => {
    browserClients.delete(ws);
    console.log("[dashboard] Browser client disconnected");
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.type === "prompt" && codexProc) {
        sendToCodex("turn/start", {
          threadId: agentState.activeThreadId,
          input: [{ type: "text", text: msg.text }],
        });
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
  events: [],
};

function pushEvent(event) {
  agentState.events.push({ ...event, timestamp: Date.now() });
  if (agentState.events.length > 500) agentState.events.shift();
  broadcast({ type: "event", data: event });
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

function startCodex() {
  console.log("[codex] Spawning app-server (stdio)...");

  codexProc = spawn("codex", ["app-server"], {
    stdio: ["pipe", "pipe", "pipe"],
  });

  codexRl = readline.createInterface({ input: codexProc.stdout });

  // Log stderr
  codexProc.stderr.on("data", (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.log("[codex stderr]", text);
  });

  codexRl.on("line", (line) => {
    console.log("[codex] ←", line);
    try {
      const msg = JSON.parse(line);

      // RPC response
      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { resolve, reject } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }

      // Notification
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
    // Restart after delay
    setTimeout(startCodex, 3000);
  });

  // Initialize handshake
  setTimeout(async () => {
    try {
      const result = await sendToCodex("initialize", {
        clientInfo: {
          name: "codex_dashboard",
          title: "Codex Dashboard",
          version: "0.1.0",
        },
      });
      console.log("[codex] Initialize result:", JSON.stringify(result));

      sendNotification("initialized");
      console.log("[codex] Handshake complete");

      agentState.connected = true;
      broadcast({ type: "status", data: { connected: true } });

      // Start a thread
      const threadResult = await sendToCodex("thread/start", {
        model: "gpt-5.1-codex",
      });
      if (threadResult?.thread?.id) {
        agentState.activeThreadId = threadResult.thread.id;
        agentState.threads[threadResult.thread.id] = {
          id: threadResult.thread.id,
          turns: [],
          createdAt: Date.now(),
        };
        console.log(`[codex] Thread started: ${threadResult.thread.id}`);
        broadcast({
          type: "thread",
          data: agentState.threads[threadResult.thread.id],
        });
      }
    } catch (e) {
      console.error("[codex] Handshake failed:", e.message);
    }
  }, 500);
}

function handleNotification(method, params) {
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
