# Codex Dashboard

Real-time dashboard for watching Codex coding agents at work.

Built by [Mac](https://github.com/mactheclawd) 🦉

## What it does

Connects to the Codex app-server via WebSocket and streams everything to a live web UI:

- Active threads and turns
- File edits in real-time
- Command output streaming
- Status indicators (thinking, writing, running, done)
- Timeline view of sessions

## Architecture

```
┌─────────────┐    WebSocket    ┌──────────────┐    WebSocket    ┌─────────┐
│ Codex Agent  │ ◄────────────► │  Dashboard    │ ◄────────────► │ Browser │
│ (app-server) │   JSON-RPC     │  Server       │   Events       │   UI    │
└─────────────┘                 └──────────────┘                 └─────────┘
```

## Stack

- **Backend:** Node.js — connects to Codex app-server, relays events to frontend
- **Frontend:** Vanilla JS + WebSocket — lightweight, no build step
- **Protocol:** JSON-RPC 2.0 (Codex) → WebSocket events (browser)

## Getting started

```bash
# Start Codex app-server
codex app-server --listen ws://127.0.0.1:4500

# Start dashboard
npm start
```

## License

MIT
