// Codex Dashboard — Browser Client

const $ = (sel) => document.querySelector(sel);
const startTime = Date.now();
let eventCount = 0;
let ws = null;
const recentFiles = new Set();

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => {
    console.log("[dashboard] Connected to server");
  };

  ws.onclose = () => {
    console.log("[dashboard] Disconnected, reconnecting...");
    setTimeout(connect, 2000);
  };

  ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleMessage(msg);
    } catch (err) {
      console.error("[dashboard] Parse error:", err);
    }
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case "state":
      applyState(msg.data);
      break;
    case "status":
      updateConnection(msg.data.connected);
      break;
    case "event":
    case "notification":
      addEvent(msg.data);
      break;
    case "thread":
      addThread(msg.data);
      break;
  }
}

function applyState(state) {
  updateConnection(state.connected);
  if (state.activeThreadId) {
    $("#detail-thread").textContent = truncId(state.activeThreadId);
  }
  if (state.events) {
    state.events.forEach((e) => addEvent(e, true));
  }
  Object.values(state.threads || {}).forEach(addThread);
}

function updateConnection(connected) {
  const dot = $("#status-dot");
  const detail = $("#detail-connection");
  const input = $("#prompt-input");
  const btn = $("#send-btn");

  if (connected) {
    dot.classList.add("connected");
    detail.textContent = "Connected";
    detail.style.color = "var(--green)";
    input.disabled = false;
    btn.disabled = false;
  } else {
    dot.classList.remove("connected");
    detail.textContent = "Disconnected";
    detail.style.color = "var(--red)";
    input.disabled = true;
    btn.disabled = true;
  }
}

function addThread(thread) {
  const list = $("#thread-list");
  // Clear empty state
  if (list.querySelector(".empty-state")) {
    list.innerHTML = "";
  }

  const existing = list.querySelector(`[data-thread="${thread.id}"]`);
  if (existing) return;

  const el = document.createElement("div");
  el.className = "thread-item active";
  el.dataset.thread = thread.id;
  el.innerHTML = `
    <div class="thread-id">${truncId(thread.id)}</div>
    <div class="thread-status">Active</div>
  `;
  list.appendChild(el);
}

function addEvent(event, bulk = false) {
  eventCount++;
  $("#event-count").textContent = `${eventCount} events`;
  $("#detail-events").textContent = eventCount;

  const stream = $("#event-stream");
  // Clear empty state
  if (stream.querySelector(".empty-state")) {
    stream.innerHTML = "";
  }

  const method = event.method || "unknown";
  const category = getCategory(method);
  const time = event.timestamp
    ? new Date(event.timestamp).toLocaleTimeString()
    : new Date().toLocaleTimeString();

  // Track files
  if (event.params?.item?.file?.path) {
    recentFiles.add(event.params.item.file.path);
    updateFileList();
  }

  // Update turn status
  if (method === "turn/started") {
    $("#detail-turn").innerHTML = `<span class="spinner"></span> Active`;
  } else if (method === "turn/completed") {
    $("#detail-turn").textContent = "Completed ✓";
    $("#detail-turn").style.color = "var(--green)";
  } else if (method === "turn/failed") {
    $("#detail-turn").textContent = "Failed ✗";
    $("#detail-turn").style.color = "var(--red)";
  }

  const card = document.createElement("div");
  card.className = "event-card";
  card.innerHTML = `
    <div class="event-header">
      <span class="event-type ${category}">${method}</span>
      <span class="event-time">${time}</span>
    </div>
    <div class="event-body">${formatBody(event)}</div>
  `;

  stream.appendChild(card);

  if (!bulk) {
    card.scrollIntoView({ behavior: "smooth", block: "end" });
  }
}

function getCategory(method) {
  if (method.startsWith("turn/")) return "turn";
  if (method.startsWith("item/stream")) return "stream";
  if (method.startsWith("item/")) return "item";
  if (method.includes("error") || method.includes("fail")) return "error";
  return "item";
}

function formatBody(event) {
  const p = event.params || {};

  // File changes
  if (p.item?.file) {
    const path = p.item.file.path || "unknown";
    return `<span class="file-path">${escHtml(path)}</span>`;
  }

  // Command execution
  if (p.item?.command) {
    return `$ ${escHtml(p.item.command.command || "")}`;
  }

  // Agent messages
  if (p.item?.message?.content) {
    const content = p.item.message.content;
    if (typeof content === "string") return escHtml(content.slice(0, 500));
    if (Array.isArray(content)) {
      return content
        .map((c) => escHtml(c.text || JSON.stringify(c)).slice(0, 300))
        .join("\n");
    }
  }

  // Stream deltas
  if (p.delta) {
    return escHtml(typeof p.delta === "string" ? p.delta : JSON.stringify(p.delta).slice(0, 300));
  }

  // Turn events
  if (p.turn) {
    return `Turn: ${truncId(p.turn.id || "?")}`;
  }

  // Fallback
  const raw = JSON.stringify(p, null, 2);
  return escHtml(raw.length > 500 ? raw.slice(0, 500) + "…" : raw);
}

function updateFileList() {
  const el = $("#file-list");
  el.innerHTML = [...recentFiles]
    .slice(-10)
    .map((f) => `<div style="padding: 2px 0; color: var(--accent);">📄 ${escHtml(f)}</div>`)
    .join("");
}

function truncId(id) {
  if (!id || id.length < 12) return id || "—";
  return id.slice(0, 8) + "…" + id.slice(-4);
}

function escHtml(s) {
  const d = document.createElement("div");
  d.textContent = s;
  return d.innerHTML;
}

// Uptime ticker
setInterval(() => {
  const secs = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  $("#detail-uptime").textContent = m > 0 ? `${m}m ${s}s` : `${s}s`;
}, 1000);

// Prompt input
$("#prompt-input").addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});

$("#send-btn").addEventListener("click", sendPrompt);

function sendPrompt() {
  const input = $("#prompt-input");
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;

  ws.send(JSON.stringify({ type: "prompt", text }));
  input.value = "";

  // Show user message in stream
  addEvent({
    method: "user/prompt",
    params: { text },
    timestamp: Date.now(),
  });
}

// Go
connect();
