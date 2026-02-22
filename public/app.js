// Codex Dashboard — Browser Client

const $ = (sel) => document.querySelector(sel);
const startTime = Date.now();
let eventCount = 0;
let ws = null;
const recentFiles = new Set();
const seenEventKeys = new Set();

// Thread state
let activeThreadId = null;
let knownThreads = []; // [{id, createdAt}]

// Streaming state
let lastAgentCard = null;
let lastThinkingCard = null;
let lastTurnStartId = null;
let lastTurnCompleteId = null;

function connect() {
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  ws = new WebSocket(`${proto}//${location.host}`);
  ws.onopen = () => console.log("[dashboard] Connected");
  ws.onclose = () => { setTimeout(connect, 2000); };
  ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); }
    catch (err) { console.error("[dashboard] Parse error:", err); }
  };
}

function handleMessage(msg) {
  switch (msg.type) {
    case "init":
      updateConnection(msg.data.connected);
      knownThreads = msg.data.threads || [];
      activeThreadId = msg.data.activeThreadId;
      renderThreadList();
      break;
    case "status":
      updateConnection(msg.data.connected);
      break;
    case "thread-events":
      // Full event replay for a thread
      if (msg.data.threadId === activeThreadId) {
        resetEventStream();
        msg.data.events.forEach((e) => addEvent(e, true));
      }
      break;
    case "new-thread":
      if (!knownThreads.find((t) => t.id === msg.data.id)) {
        knownThreads.push(msg.data);
      }
      renderThreadList();
      break;
    case "active-thread":
      activeThreadId = msg.data.threadId;
      $("#detail-thread").textContent = truncId(activeThreadId);
      renderThreadList();
      break;
    case "thread-title": {
      const t = knownThreads.find((t) => t.id === msg.data.threadId);
      if (t) { t.title = msg.data.title; renderThreadList(); }
      break;
    }
    case "event":
    case "notification":
      addEvent(msg.data);
      break;
  }
}

function resetEventStream() {
  seenEventKeys.clear();
  eventCount = 0;
  lastAgentCard = null;
  lastThinkingCard = null;
  lastTurnStartId = null;
  lastTurnCompleteId = null;
  const stream = $("#event-stream");
  stream.innerHTML = `<div class="empty-state"><div class="emoji">👀</div><div>No events yet</div><div style="font-size:12px;">Send a prompt to get started</div></div>`;
  $("#event-count").textContent = "0 events";
  $("#detail-events").textContent = "0";
}

function renderThreadList() {
  const list = $("#thread-list");
  list.innerHTML = "";
  if (knownThreads.length === 0) {
    list.innerHTML = `<div class="empty-state"><div class="emoji">🔌</div><div>No threads yet</div></div>`;
    return;
  }
  for (const t of knownThreads) {
    const el = document.createElement("div");
    el.className = "thread-item" + (t.id === activeThreadId ? " active" : "");
    el.dataset.thread = t.id;
    const title = t.title || truncId(t.id);
    const status = t.id === activeThreadId ? "Active" : "Click to load";
    el.innerHTML = `<div class="thread-id">${esc(title)}</div><div class="thread-status">${status}</div>`;
    el.addEventListener("click", () => switchThread(t.id));
    list.appendChild(el);
  }
}

function switchThread(threadId) {
  if (threadId === activeThreadId) return;
  activeThreadId = threadId;
  resetEventStream();
  renderThreadList();
  $("#detail-thread").textContent = truncId(threadId);
  toggleSidebar(false); // close sidebar on mobile
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "switch-thread", threadId }));
  }
}

function updateConnection(connected) {
  const dot = $("#status-dot");
  const detail = $("#detail-connection");
  const input = $("#prompt-input");
  const btn = $("#send-btn");
  if (connected) {
    dot.classList.add("connected");
    detail.textContent = "Connected"; detail.style.color = "var(--green)";
    input.disabled = false; btn.disabled = false;
  } else {
    dot.classList.remove("connected");
    detail.textContent = "Disconnected"; detail.style.color = "var(--red)";
    input.disabled = true; btn.disabled = true;
  }
}

// ─── Event routing ───

function addEvent(event, bulk = false) {
  const method = event.method || "unknown";
  const params = event.params || {};

  // Deduplicate
  const itemId = params.item?.id || params.itemId;
  const turnId = params.turn?.id || params.turnId;
  const dedupeKey = itemId ? `${method}:${itemId}` : turnId ? `${method}:${turnId}` : null;
  if (dedupeKey && method !== "item/agentMessage/delta" && method !== "item/reasoning/summaryTextDelta") {
    if (seenEventKeys.has(dedupeKey)) return;
    seenEventKeys.add(dedupeKey);
  }

  // Hard skip list
  if (method.startsWith("codex/event/")) return;
  if (method === "thread/started") return;
  if (method === "thread/created") return;
  if (method === "thread/tokenUsage/updated") return;
  if (method === "account/rateLimits/updated") return;
  if (method === "item/created") return;
  if (method === "item/reasoning/summaryPartAdded") return;

  // Streaming handlers
  if (method === "item/agentMessage/delta") {
    appendAgentDelta(params.delta || "", params.itemId);
    return;
  }
  if (method === "item/reasoning/summaryTextDelta") {
    appendThinkingDelta(params.delta || "");
    return;
  }

  if (method === "item/started") {
    const type = params.item?.type;
    if (type === "reasoning") {
      renderCard(event, bulk, {
        category: "stream", cardClass: "thinking-card collapsible", icon: "💭",
        label: "Thinking", body: `<span class="thinking-text"></span>`, collapsible: true,
      }, (card) => { lastThinkingCard = card; });
      return;
    }
    return;
  }

  if (method === "item/completed") {
    const item = params.item || {};
    if (item.type === "reasoning") {
      const summary = (item.summary || []).join(" ");
      if (lastThinkingCard) {
        const el = lastThinkingCard.querySelector(".thinking-text");
        if (el && summary) el.textContent = summary;
        lastThinkingCard = null;
      }
      return;
    }
    if (item.type === "agentMessage") {
      if (lastAgentCard) {
        const el = lastAgentCard.querySelector(".streaming-text");
        if (el && item.text) el.textContent = item.text;
        lastAgentCard = null;
        return;
      }
      if (item.id && document.querySelector(`[data-item-id="${item.id}"]`)) return;
      if (item.text) {
        renderCard(event, bulk, {
          category: "agent", cardClass: "agent-message", icon: "🤖",
          label: "Codex", body: `<span class="msg-text">${esc(item.text)}</span>`,
        });
      }
      return;
    }
    if (item.type === "userMessage") return;
    if (item.type === "webSearch") {
      const query = item.query || "";
      const action = item.action;
      let body = esc(query);
      if (action?.type === "openPage" && action.url) {
        body += `\n<span class="tool-args">→ ${esc(action.url)}</span>`;
      }
      renderCard(event, bulk, {
        category: "stream", cardClass: "tool-call-card collapsible", icon: "🔍",
        label: "Web Search", body, collapsible: true,
      });
      return;
    }
    if (item.type === "commandExecution") {
      const exitCode = item.exitCode ?? item.command?.exitCode;
      const output = item.output || "";
      const cmd = item.call?.command || item.command || "";
      const cmdStr = typeof cmd === "string" ? cmd : JSON.stringify(cmd);
      const ok = exitCode === 0;
      let body = cmdStr ? `<span class="cmd">$ ${esc(cmdStr)}</span>\n` : "";
      body += ok ? "✓" : `✗ (exit ${exitCode})`;
      if (output) {
        const trimmed = output.length > 500 ? output.slice(0, 500) + "…" : output;
        body += `\n<span class="tool-args">${esc(trimmed)}</span>`;
      }
      renderCard(event, bulk, {
        category: ok ? "turn" : "error",
        cardClass: "tool-call-card collapsible",
        icon: ok ? "⚡" : "❌", label: "Command", body, collapsible: true,
      });
      return;
    }
    return;
  }

  if (method === "turn/started") {
    const tid = params.turn?.id || params.turnId;
    if (tid && tid === lastTurnStartId) return;
    lastTurnStartId = tid;
    lastAgentCard = null;
    lastThinkingCard = null;
    updateTurnStatus("active");
    renderCard(event, bulk, {
      category: "turn", cardClass: "", icon: "▶️",
      label: "Turn started", body: "Codex is thinking…",
    });
    return;
  }

  if (method === "turn/completed") {
    const tid = params.turn?.id || params.turnId;
    if (tid && tid === lastTurnCompleteId) return;
    lastTurnCompleteId = tid;
    lastAgentCard = null;
    lastThinkingCard = null;
    updateTurnStatus("completed");
    renderCard(event, bulk, {
      category: "turn", cardClass: "", icon: "✅",
      label: "Turn completed", body: formatTurnSummary(params),
    });
    return;
  }

  if (method === "turn/failed") {
    updateTurnStatus("failed");
    renderCard(event, bulk, {
      category: "error", cardClass: "", icon: "❌",
      label: "Turn failed", body: esc(params.error?.message || params.reason || "Unknown error"),
    });
    return;
  }

  if (method === "user/prompt") {
    renderCard(event, bulk, {
      category: "user", cardClass: "user-message", icon: "💬",
      label: "You", body: `<span class="msg-text">${esc(params.text || "")}</span>`,
    });
    return;
  }

  console.log("[dashboard] Unhandled:", method);
}

// ─── Card rendering ───

function renderCard(event, bulk, { category, cardClass, icon, label, body, collapsible }, afterInsert) {
  eventCount++;
  $("#event-count").textContent = `${eventCount} events`;
  $("#detail-events").textContent = eventCount;

  const stream = $("#event-stream");
  if (stream.querySelector(".empty-state")) stream.innerHTML = "";

  const time = event.timestamp
    ? new Date(event.timestamp).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

  const toggle = collapsible ? '<span class="collapse-toggle">▶</span>' : "";
  const card = document.createElement("div");
  card.className = `event-card ${cardClass}`;
  card.innerHTML = `
    <div class="event-header">
      <span class="event-type ${category}">${toggle}${icon} ${label}</span>
      <span class="event-time">${time}</span>
    </div>
    <div class="event-body">${body}</div>
  `;

  if (collapsible) {
    card.querySelector(".event-header").addEventListener("click", () => {
      card.classList.toggle("expanded");
    });
  }

  stream.appendChild(card);
  if (!bulk) card.scrollIntoView({ behavior: "smooth", block: "end" });
  if (afterInsert) afterInsert(card);

  const filePath = event.params?.item?.file?.path;
  if (filePath) { recentFiles.add(filePath); updateFileList(); }
}

// ─── Streaming helpers ───

function appendAgentDelta(delta, itemId) {
  const stream = $("#event-stream");
  if (!lastAgentCard || !stream.contains(lastAgentCard)) {
    if (stream.querySelector(".empty-state")) stream.innerHTML = "";
    lastAgentCard = document.createElement("div");
    lastAgentCard.className = "event-card agent-message";
    if (itemId) lastAgentCard.dataset.itemId = itemId;
    lastAgentCard.innerHTML = `
      <div class="event-header">
        <span class="event-type agent">🤖 Codex</span>
        <span class="event-time">${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>
      </div>
      <div class="event-body"><span class="msg-text streaming-text"></span></div>
    `;
    stream.appendChild(lastAgentCard);
    eventCount++;
    $("#event-count").textContent = `${eventCount} events`;
    $("#detail-events").textContent = eventCount;
  }
  const el = lastAgentCard.querySelector(".streaming-text");
  if (el) el.textContent += (typeof delta === "string" ? delta : JSON.stringify(delta));
  lastAgentCard.scrollIntoView({ behavior: "smooth", block: "end" });
}

function appendThinkingDelta(delta) {
  const stream = $("#event-stream");
  if (!lastThinkingCard || !stream.contains(lastThinkingCard)) {
    const cards = stream.querySelectorAll(".thinking-card");
    lastThinkingCard = cards.length ? cards[cards.length - 1] : null;
  }
  if (lastThinkingCard) {
    const el = lastThinkingCard.querySelector(".thinking-text");
    if (el) el.textContent += delta;
  }
}

// ─── Status helpers ───

function updateTurnStatus(state) {
  const el = $("#detail-turn");
  if (state === "active") {
    el.innerHTML = `<span class="spinner"></span> Active`;
    el.style.color = "";
  } else if (state === "completed") {
    el.textContent = "Completed ✓"; el.style.color = "var(--green)";
  } else if (state === "failed") {
    el.textContent = "Failed ✗"; el.style.color = "var(--red)";
  }
}

function formatTurnSummary(params) {
  const items = (params.turn?.items || []);
  const files = items.filter((i) => i.file).length;
  const cmds = items.filter((i) => i.type === "command" || i.type === "commandExecution").length;
  const msgs = items.filter((i) => i.type === "agentMessage").length;
  const parts = [];
  if (msgs) parts.push(`${msgs} message${msgs > 1 ? "s" : ""}`);
  if (files) parts.push(`${files} file${files > 1 ? "s" : ""}`);
  if (cmds) parts.push(`${cmds} command${cmds > 1 ? "s" : ""}`);
  return parts.length ? parts.join(" · ") : "Done";
}

function updateFileList() {
  const el = $("#file-list");
  if (!el) return;
  el.innerHTML = [...recentFiles].slice(-10)
    .map((f) => `<div style="padding:2px 0;color:var(--accent);">📄 ${esc(f)}</div>`).join("");
}

// ─── Utilities ───

function truncId(id) {
  if (!id || id.length < 12) return id || "—";
  return id.slice(0, 8) + "…" + id.slice(-4);
}

function esc(s) {
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
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendPrompt(); }
});
$("#send-btn").addEventListener("click", sendPrompt);

// New thread button
$("#new-thread-btn").addEventListener("click", () => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "new-thread" }));
  }
});

function sendPrompt() {
  const input = $("#prompt-input");
  const text = input.value.trim();
  if (!text || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "prompt", text }));
  input.value = "";
  lastAgentCard = null;
  addEvent({ method: "user/prompt", params: { text }, timestamp: Date.now() });
  // Set thread title from first prompt
  const thread = knownThreads.find((t) => t.id === activeThreadId);
  if (thread && !thread.title) {
    thread.title = text.length > 50 ? text.slice(0, 50) + "…" : text;
    renderThreadList();
  }
}

// Mobile sidebar toggle
const menuBtn = $("#menu-btn");
const sidebar = $(".sidebar");
const backdrop = $("#sidebar-backdrop");

function toggleSidebar(open) {
  const isOpen = sidebar.classList.contains("open");
  const shouldOpen = open !== undefined ? open : !isOpen;
  sidebar.classList.toggle("open", shouldOpen);
  backdrop.classList.toggle("open", shouldOpen);
}

menuBtn.addEventListener("click", () => toggleSidebar());
backdrop.addEventListener("click", () => toggleSidebar(false));

// Swipe gestures for mobile sidebar
let touchStartX = 0;
let touchStartY = 0;
let touchStartTime = 0;

document.addEventListener("touchstart", (e) => {
  touchStartX = e.touches[0].clientX;
  touchStartY = e.touches[0].clientY;
  touchStartTime = Date.now();
}, { passive: true });

document.addEventListener("touchend", (e) => {
  const dx = e.changedTouches[0].clientX - touchStartX;
  const dy = e.changedTouches[0].clientY - touchStartY;
  const dt = Date.now() - touchStartTime;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  // Must be horizontal, fast-ish, and significant distance
  if (absDx < 50 || absDy > absDx || dt > 400) return;

  const isOpen = sidebar.classList.contains("open");
  if (dx > 0 && !isOpen && touchStartX < 40) toggleSidebar(true);   // swipe right from left edge
  if (dx < 0 && isOpen) toggleSidebar(false);                        // swipe left to close
}, { passive: true });

connect();
