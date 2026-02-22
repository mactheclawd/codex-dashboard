// Codex Dashboard — Browser Client

const $ = (sel) => document.querySelector(sel);
const startTime = Date.now();
let eventCount = 0;
let ws = null;
const recentFiles = new Set();

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);

  ws.onopen = () => console.log("[dashboard] Connected to server");

  ws.onclose = () => {
    console.log("[dashboard] Disconnected, reconnecting...");
    setTimeout(connect, 2000);
  };

  ws.onmessage = (e) => {
    try {
      handleMessage(JSON.parse(e.data));
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
  if (list.querySelector(".empty-state")) list.innerHTML = "";
  if (list.querySelector(`[data-thread="${thread.id}"]`)) return;

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
  const method = event.method || "unknown";
  const params = event.params || {};

  // Skip noisy internal events
  if (shouldSkipEvent(method, params)) return;

  eventCount++;
  $("#event-count").textContent = `${eventCount} events`;
  $("#detail-events").textContent = eventCount;

  const stream = $("#event-stream");
  if (stream.querySelector(".empty-state")) stream.innerHTML = "";

  const time = event.timestamp
    ? new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  // Track files
  const filePath = params.item?.file?.path;
  if (filePath) {
    recentFiles.add(filePath);
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

  const { category, cardClass, icon, label, body } = formatEvent(method, params);

  const card = document.createElement("div");
  card.className = `event-card ${cardClass}`;
  card.innerHTML = `
    <div class="event-header">
      <span class="event-type ${category}">${icon} ${label}</span>
      <span class="event-time">${time}</span>
    </div>
    <div class="event-body">${body}</div>
  `;

  stream.appendChild(card);
  if (!bulk) card.scrollIntoView({ behavior: "smooth", block: "end" });
}

function shouldSkipEvent(method, params) {
  // Skip raw thread/started (we handle it via state)
  if (method === "thread/started") return true;
  // Skip MCP startup noise
  if (method === "codex/event/mcp_startup_complete") return true;
  // Skip session configured
  if (method === "codex/event/session_configured") return true;
  return false;
}

function formatEvent(method, params) {
  // User prompt
  if (method === "user/prompt") {
    return {
      category: "user",
      cardClass: "user-message",
      icon: "💬",
      label: "You",
      body: `<span class="msg-text">${escHtml(params.text || "")}</span>`,
    };
  }

  // Turn started
  if (method === "turn/started") {
    return {
      category: "turn",
      cardClass: "",
      icon: "▶️",
      label: "Turn started",
      body: `Codex is thinking...`,
    };
  }

  // Turn completed
  if (method === "turn/completed") {
    return {
      category: "turn",
      cardClass: "",
      icon: "✅",
      label: "Turn completed",
      body: formatTurnSummary(params),
    };
  }

  // Turn failed
  if (method === "turn/failed") {
    return {
      category: "error",
      cardClass: "",
      icon: "❌",
      label: "Turn failed",
      body: escHtml(params.error?.message || params.reason || "Unknown error"),
    };
  }

  // Agent message
  if (method === "item/created" && params.item?.type === "agentMessage") {
    const content = extractContent(params.item);
    return {
      category: "agent",
      cardClass: "agent-message",
      icon: "🤖",
      label: "Codex",
      body: `<span class="msg-text">${escHtml(content)}</span>`,
    };
  }

  // File change
  if (method === "item/created" && params.item?.file) {
    const path = params.item.file.path || "unknown";
    const action = params.item.file.status || "modified";
    return {
      category: "item",
      cardClass: "file-change",
      icon: "📄",
      label: `File ${action}`,
      body: `<span class="file-path">${escHtml(path)}</span>`,
    };
  }

  // Command execution
  if (method === "item/created" && params.item?.type === "command") {
    const cmd = params.item.command?.command || params.item.command || "";
    return {
      category: "stream",
      cardClass: "command-run",
      icon: "⚡",
      label: "Command",
      body: `<span class="cmd">$ ${escHtml(typeof cmd === "string" ? cmd : JSON.stringify(cmd))}</span>`,
    };
  }

  // Streaming delta — agent typing
  if (method === "item/agentMessage/delta") {
    const delta = params.delta || "";
    // Append to last agent message card if exists
    appendDelta(delta);
    return null; // handled by appendDelta
  }

  // Item completed
  if (method === "item/completed") {
    const item = params.item || {};
    if (item.type === "command") {
      const exitCode = item.command?.exitCode ?? item.exitCode;
      const status = exitCode === 0 ? "✓" : `✗ (exit ${exitCode})`;
      return {
        category: exitCode === 0 ? "turn" : "error",
        cardClass: "",
        icon: exitCode === 0 ? "✅" : "❌",
        label: "Command done",
        body: `${status}`,
      };
    }
    // Skip other item/completed silently
    return null;
  }

  // Approval request
  if (method === "codex/event/approval_request") {
    const cmd = params.command?.command || params.command || "unknown";
    return {
      category: "stream",
      cardClass: "",
      icon: "🔐",
      label: "Approval needed",
      body: `<span class="cmd">$ ${escHtml(typeof cmd === "string" ? cmd : JSON.stringify(cmd))}</span>`,
    };
  }

  // Generic fallback — keep it clean
  return {
    category: "item",
    cardClass: "",
    icon: "📡",
    label: shortMethod(method),
    body: formatCompact(params),
  };
}

// Append streaming delta to the last agent message
let lastAgentCard = null;

function appendDelta(delta) {
  const stream = $("#event-stream");
  if (!lastAgentCard || !stream.contains(lastAgentCard)) {
    // Create a new streaming card
    if (stream.querySelector(".empty-state")) stream.innerHTML = "";
    lastAgentCard = document.createElement("div");
    lastAgentCard.className = "event-card agent-message";
    lastAgentCard.innerHTML = `
      <div class="event-header">
        <span class="event-type agent">🤖 Codex</span>
        <span class="event-time">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
      </div>
      <div class="event-body"><span class="msg-text streaming-text"></span></div>
    `;
    stream.appendChild(lastAgentCard);
  }
  const textEl = lastAgentCard.querySelector(".streaming-text");
  if (textEl) {
    textEl.textContent += (typeof delta === "string" ? delta : JSON.stringify(delta));
  }
  lastAgentCard.scrollIntoView({ behavior: "smooth", block: "end" });
}

// When a non-delta event arrives, clear the streaming target
const origAddEvent = addEvent;

function extractContent(item) {
  if (!item) return "";
  const c = item.message?.content || item.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((x) => x.text || "").join("");
  return JSON.stringify(c || {});
}

function formatTurnSummary(params) {
  const turn = params.turn || {};
  const items = turn.items || [];
  const files = items.filter((i) => i.file).length;
  const cmds = items.filter((i) => i.type === "command").length;
  const msgs = items.filter((i) => i.type === "agentMessage").length;
  const parts = [];
  if (msgs) parts.push(`${msgs} message${msgs > 1 ? "s" : ""}`);
  if (files) parts.push(`${files} file${files > 1 ? "s" : ""}`);
  if (cmds) parts.push(`${cmds} command${cmds > 1 ? "s" : ""}`);
  return parts.length ? parts.join(" · ") : "Done";
}

function shortMethod(method) {
  // Shorten long method names
  return method
    .replace("codex/event/", "")
    .replace("item/", "")
    .replace(/([A-Z])/g, " $1")
    .trim();
}

function formatCompact(params) {
  // Show a one-line summary instead of full JSON
  const keys = Object.keys(params);
  if (keys.length === 0) return "—";
  if (keys.length <= 3) {
    return keys
      .map((k) => {
        const v = params[k];
        const s = typeof v === "string" ? v : JSON.stringify(v);
        return `${k}: ${escHtml(s.length > 60 ? s.slice(0, 60) + "…" : s)}`;
      })
      .join("\n");
  }
  const raw = JSON.stringify(params, null, 2);
  return escHtml(raw.length > 300 ? raw.slice(0, 300) + "…" : raw);
}

function updateFileList() {
  const el = $("#file-list");
  if (!el) return;
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
  const el = $("#detail-uptime");
  if (!el) return;
  const secs = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  el.textContent = m > 0 ? `${m}m ${s}s` : `${s}s`;
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

  // Reset streaming target
  lastAgentCard = null;

  addEvent({
    method: "user/prompt",
    params: { text },
    timestamp: Date.now(),
  });
}

connect();
