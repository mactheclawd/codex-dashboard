import { WebSocketServer, WebSocket } from "ws";
import { createServer } from "http";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const CODEX_URL = process.env.CODEX_URL || "ws://127.0.0.1:4500";
const PORT = process.env.PORT || 3111;

// --- HTTP server for static files ---
const httpServer = createServer((req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(readFileSync(join(__dirname, "../public/index.html")));
  } else if (req.url === "/app.js") {
    res.writeHead(200, { "Content-Type": "application/javascript" });
    res.end(readFileSync(join(__dirname, "../public/app.js")));
  } else if (req.url === "/style.css") {
    res.writeHead(200, { "Content-Type": "text/css" });
    res.end(readFileSync(join(__dirname, "../public/style.css")));
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
    // Handle commands from browser (e.g., send prompt to Codex)
    try {
      const msg = JSON.parse(data);
      if (msg.type === "prompt" && codexWs?.readyState === WebSocket.OPEN) {
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
  events: [], // rolling log of recent events
};

function pushEvent(event) {
  agentState.events.push({ ...event, timestamp: Date.now() });
  if (agentState.events.length > 500) agentState.events.shift();
  broadcast({ type: "event", data: event });
}

// --- Codex app-server connection ---
let codexWs = null;
let rpcId = 100;
const pendingRequests = new Map();

function sendToCodex(method, params = {}) {
  const id = rpcId++;
  const msg = { method, id, params };
  codexWs.send(JSON.stringify(msg));
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

function connectToCodex() {
  console.log(`[codex] Connecting to ${CODEX_URL}...`);
  codexWs = new WebSocket(CODEX_URL);

  codexWs.on("open", async () => {
    console.log("[codex] Connected to app-server");
    agentState.connected = true;
    broadcast({ type: "status", data: { connected: true } });

    try {
      // Initialize handshake
      await sendToCodex("initialize", {
        clientInfo: {
          name: "codex_dashboard",
          title: "Codex Dashboard",
          version: "0.1.0",
        },
      });
      codexWs.send(JSON.stringify({ method: "initialized", params: {} }));
      console.log("[codex] Handshake complete");

      // Start a thread
      const result = await sendToCodex("thread/start", {
        model: "gpt-5.1-codex",
      });
      if (result?.thread?.id) {
        agentState.activeThreadId = result.thread.id;
        agentState.threads[result.thread.id] = {
          id: result.thread.id,
          turns: [],
          createdAt: Date.now(),
        };
        console.log(`[codex] Thread started: ${result.thread.id}`);
        broadcast({ type: "thread", data: agentState.threads[result.thread.id] });
      }
    } catch (e) {
      console.error("[codex] Handshake failed:", e.message);
    }
  });

  codexWs.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);

      // RPC response
      if (msg.id !== undefined && pendingRequests.has(msg.id)) {
        const { resolve, reject } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }

      // Notification (no id)
      if (msg.method) {
        handleNotification(msg.method, msg.params || {});
      }
    } catch (e) {
      console.error("[codex] Parse error:", e.message);
    }
  });

  codexWs.on("close", () => {
    console.log("[codex] Disconnected from app-server");
    agentState.connected = false;
    broadcast({ type: "status", data: { connected: false } });
    // Reconnect after delay
    setTimeout(connectToCodex, 3000);
  });

  codexWs.on("error", (err) => {
    console.error("[codex] WebSocket error:", err.message);
  });
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
    case "item/created":
    case "item/updated":
      // These contain file edits, command runs, messages, etc.
      break;
    case "item/stream/delta":
      // Streaming content — forward as-is for live rendering
      break;
  }

  broadcast({ type: "notification", data: event });
}

// --- Start ---
httpServer.listen(PORT, () => {
  console.log(`[dashboard] UI at http://localhost:${PORT}`);
  connectToCodex();
});
