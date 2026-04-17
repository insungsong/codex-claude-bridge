# Codex Bridge

### Make Claude Code and OpenAI Codex talk to each other — across multiple rooms.

Run multiple Codex ↔ Claude pairs simultaneously, each isolated by ticket number.  
One `covering-bridge` command manages all rooms from a single terminal.

![Codex Bridge UI showing a live multi-turn exchange between Codex and Claude](screenshot.png)

---

## Overview

```
Room ENG-1234:  Codex-A  ↔  Claude-A   (feature A)
Room ENG-5678:  Codex-B  ↔  Claude-B   (feature B)
Room ENG-9999:  Codex-C  ↔  Claude-C   (feature C)
```

Each room is completely isolated — messages never cross between rooms.  
A single central `bridge-server` handles routing. The `covering-bridge` CLI opens new rooms on demand.

<p align="center">
  <img src="architecture.svg" alt="Codex Bridge architecture diagram" width="800"/>
</p>

---

## What you need

- [Bun](https://bun.sh) — `bun --version` to check, install from bun.sh
- [Claude Code](https://code.claude.com) v2.1.80+
- [Codex CLI](https://github.com/openai/codex) with an OpenAI API key

---

## Installation

```bash
git clone <your-fork-url>
cd codex-claude-bridge
bun install
```

---

## Setup

### 1. Register Claude-side MCP

Add to `~/.mcp.json` (create if missing):

```json
{
  "mcpServers": {
    "codex-bridge": {
      "type": "stdio",
      "command": "bun",
      "args": ["/full/path/to/codex-claude-bridge/claude-mcp.ts"]
    }
  }
}
```

> The room is selected at runtime via `CODEX_BRIDGE_ROOM` env var — no need for a separate config per room.

### 2. Register Codex-side MCP

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.codex-bridge]
command = "bun"
args = ["/full/path/to/codex-claude-bridge/codex-mcp.ts"]
tool_timeout_sec = 120
```

`tool_timeout_sec = 120` is required — `send_to_claude` can wait up to 2 minutes for Claude's reply.

---

## Running rooms

### Option A — covering-bridge CLI (recommended)

```bash
bun covering-bridge.ts
```

This opens an interactive terminal UI:

```
  Codex–Claude Bridge  v0.3 multi-room
  http://localhost:8788

  ENG-1234   claude ✓  codex ✓   12m ago
  ENG-5678   claude ✓  codex ✗    3m ago

  [o] open new room   [c] close room   [t] stop terminals   [r] refresh   [q] quit

  > o
  Ticket number (e.g. ENG-1234): ENG-9999

  Opening room ENG-9999...
  ✓ tmux window opened (claude left, codex right)
```

The bridge server starts automatically if not already running.  
Rooms stay open until you explicitly close them with `[c]`.
Closing a room from `covering-bridge` also sends `SIGTERM` and a `SIGKILL` fallback to the room's `bridge-claude` / `bridge-codex` processes when they are still running.
Use `[t]` when you want to stop bridge-launched terminals without deleting the room itself.

**Terminal support:**
- **tmux** — new window, split-pane (claude left, codex right)
- **iTerm2** — two new tabs
- **Terminal.app** — two new windows
- **Fallback** — prints commands to run manually

### Option B — manual per-room launch

Start the central server once:

```bash
bun bridge-server.ts
```

Then for each room, open two terminals:

```bash
# Terminal 1 — Claude
CODEX_BRIDGE_ROOM=ENG-1234 claude --dangerously-load-development-channels server:codex-bridge

# Terminal 2 — Codex
CODEX_BRIDGE_ROOM=ENG-1234 codex --full-auto
```

Repeat with a different `CODEX_BRIDGE_ROOM` value for each additional room.

---

## Web UI

Open [http://localhost:8788](http://localhost:8788) to watch all rooms in real time.

- Use the **room selector** dropdown to switch between active rooms
- **Purple bubbles** (left) = Claude
- **Green bubbles** (right) = Codex
- **Gray bubbles** = you (human observer via the text box)

---

## Starting a conversation

From inside a Codex session, tell it:

```
Use the send_to_claude tool to discuss whether we should use Redis or Memcached for caching.
Keep going until you reach a decision.
```

Codex calls `send_to_claude()` → bridge pushes to Claude → Claude replies → bridge returns to Codex.  
Codex keeps calling `send_to_claude()` until consensus is reached.

---

## Files

```
bridge-server.ts    Central HTTP server. Manages all rooms. Run once.
claude-mcp.ts       Claude-side MCP relay. One instance per room (CODEX_BRIDGE_ROOM).
codex-mcp.ts        Codex-side MCP server. One instance per room (CODEX_BRIDGE_ROOM).
covering-bridge.ts  Interactive CLI. Manages rooms, opens terminals automatically.
```

Legacy `server.ts` is kept for reference — it combined the HTTP server and Claude MCP in one process (single-room only).

---

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `CODEX_BRIDGE_ROOM` | *(required)* | Room ID — use your ticket number e.g. `ENG-1234` |
| `CODEX_BRIDGE_URL` | `http://localhost:8788` | Bridge server URL |
| `CODEX_BRIDGE_PORT` | `8788` | Bridge server port |

---

## npm scripts

```bash
bun run bridge       # covering-bridge CLI (room manager)
bun run server       # bridge-server (central HTTP server)
bun run claude-mcp   # claude-mcp.ts (set CODEX_BRIDGE_ROOM first)
bun run codex-mcp    # codex-mcp.ts (set CODEX_BRIDGE_ROOM first)
```

---

## How it works

```
Codex  →  codex-mcp.ts  →  POST /api/rooms/ENG-1234/from-codex
                         →  bridge-server stores in pendingForClaude
                         →  claude-mcp.ts long-polls pending-for-claude
                         →  mcp.notification() → Claude sees message
                         →  Claude calls reply tool
                         →  claude-mcp.ts  →  POST /api/rooms/ENG-1234/from-claude
                         →  bridge-server resolves Codex's waiting poll
Codex  ←  send_to_claude() returns Claude's reply
```

Each room has its own isolated state: pending replies, in-flight deduplication, and message queues never touch other rooms.

---

## Known limitations

- Claude → Codex is still queue-based: Claude-initiated messages wait until Codex polls. Codex-initiated turns are the real-time path.
- Both agents must be on the same machine (localhost bridge).
- `--dangerously-load-development-channels` flag is required for Claude Code (Channels are a research preview).
- Claude must include `reply_to` when replying — if omitted, the reply appears in the web UI but won't route back to Codex.

---

## License

MIT
