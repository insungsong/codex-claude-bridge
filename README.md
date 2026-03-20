# Codex Bridge

A bidirectional bridge that lets Claude Code and OpenAI Codex CLI talk to each other in real time. Watch two AI agents debate, collaborate, and reach consensus from a web UI.

![Codex Bridge UI showing Claude and Codex discussing Redis vs Memcached](screenshot.png)

Neither Claude Code nor Codex natively supports agent-to-agent communication. MCP is request-response only. A2A isn't supported by either tool. This bridge works around both limitations using Claude Code's channel system on one side and a blocking MCP tool on the other.

## How it works

```
┌─────────────┐                                     ┌─────────────┐
│  Claude Code │                                     │  Codex CLI  │
│  (channel)   │                                     │  (MCP tool) │
└──────┬───────┘                                     └──────┬──────┘
       │ stdio                                              │ stdio
       │                                                    │
┌──────▼────────────────────────────────────────────────────▼──────┐
│                        Codex Bridge                              │
│                                                                  │
│  server.ts (Claude side)           codex-mcp.ts (Codex side)     │
│  - Channel push notifications      - send_to_claude() blocks    │
│  - reply / send_to_codex tools        until Claude responds      │
│  - Web UI on localhost:8788        - check_claude_messages()     │
│                         ↕ HTTP API ↕                             │
└──────────────────────────────────────────────────────────────────┘
                              ↕
                     Browser (localhost:8788)
```

The trick: Claude Code has a "channels" feature that lets MCP servers push messages into a running session. Codex doesn't have anything like that. So we use a blocking tool call on the Codex side — when Codex calls `send_to_claude()`, the bridge holds the connection open until Claude replies. From Codex's perspective it's just a tool call that takes a bit to return. From Claude's perspective it's a channel notification it can react to.

## What you need

- [Bun](https://bun.sh) (`bun --version` to check, install from bun.sh if missing)
- [Claude Code](https://code.claude.com) v2.1.80+ with a claude.ai account
- [Codex CLI](https://github.com/openai/codex) with an OpenAI API key or ChatGPT login

## Setup

### 1. Clone and install

```bash
git clone https://github.com/abhishekgahlot2/codex-claude-bridge.git
cd codex-claude-bridge
bun install
```

### 2. Register the bridge with Claude Code

Add `codex-bridge` to your Claude Code MCP config. Open `~/.mcp.json` (create it if it doesn't exist) and add:

```json
{
  "mcpServers": {
    "codex-bridge": {
      "type": "stdio",
      "command": "bun",
      "args": ["/full/path/to/codex-claude-bridge/server.ts"]
    }
  }
}
```

Replace `/full/path/to` with wherever you cloned the repo.

### 3. Register the bridge with Codex CLI

Add the Codex-side MCP server to `~/.codex/config.toml`:

```toml
[mcp_servers.codex-bridge]
command = "bun"
args = ["/full/path/to/codex-claude-bridge/codex-mcp.ts"]
tool_timeout_sec = 120
```

The `tool_timeout_sec = 120` is needed because `send_to_claude` blocks while waiting for Claude's reply. The default 60s timeout will kill the connection too early.

### 4. Start Claude Code with the channel

```bash
claude --dangerously-load-development-channels server:codex-bridge
```

You should see `Listening for channel messages from: server:codex-bridge` in the output.

### 5. Start Codex CLI

In a separate terminal:

```bash
codex
```

Codex will auto-load the `codex-bridge` MCP server from your config. You can verify by running `/mcp` inside Codex — you should see `codex-bridge` listed with `send_to_claude` and `check_claude_messages` tools.

### 6. Open the web UI

Go to [http://localhost:8788](http://localhost:8788) in your browser. This is where you watch the conversation happen.

## Usage

The conversation flows best when started from Codex's side. Tell Codex something like:

```
Use send_to_claude to discuss whether we should use Redis or Memcached for caching. Keep going until you agree.
```

Codex will call `send_to_claude()`, which sends the message through the bridge to Claude. Claude gets a channel notification, processes it, and replies. The bridge routes Claude's response back to Codex as the tool result. Codex reads it and can call `send_to_claude()` again to continue the discussion.

You can also inject messages from the web UI as a human observer — type something and it goes straight to Claude's session.

### Starting from Claude's side

Claude has a `send_to_codex` tool, but since Codex can't receive push notifications, the message sits in a queue until Codex checks for it. You'd have to tell Codex to "call check_claude_messages" to pick it up. Works, but the Codex-initiated flow is smoother.

### Watching the conversation

The web UI at localhost:8788 shows all messages in real time:
- Purple bubbles on the left = Claude
- Green bubbles on the right = Codex
- Gray bubbles = you (human observer from the web UI)

## Files

| File | What it does |
|------|------|
| `server.ts` | Claude Code channel plugin. Runs as an MCP server over stdio, serves the web UI, and exposes HTTP API endpoints for the Codex side. |
| `codex-mcp.ts` | Codex CLI MCP server. Exposes `send_to_claude()` and `check_claude_messages()` tools. Talks to `server.ts` over HTTP. |
| `.mcp.json` | Plugin config for Claude Code's plugin system. |
| `.claude-plugin/plugin.json` | Plugin metadata. |

## Configuration

| Env var | Default | What it does |
|---------|---------|------|
| `CODEX_BRIDGE_PORT` | `8788` | Port for the web UI and internal API |
| `CODEX_BRIDGE_URL` | `http://localhost:8788` | URL the Codex-side MCP server uses to reach the bridge (change if you moved the port) |

## Known limitations

- Codex can't receive push notifications. The conversation works best when Codex initiates. Claude-initiated messages require Codex to poll.
- Claude sometimes doesn't set `reply_to` on its responses. The bridge works around this by resolving the oldest pending request, but it can cause replies to land on the wrong message if multiple are in flight.
- The bridge runs on localhost only. Both Claude Code and Codex CLI need to be on the same machine.
- Channels are a Claude Code research preview feature. The `--dangerously-load-development-channels` flag is required until the plugin gets on the approved allowlist.

## Why not just use MCP / A2A?

Both Claude Code and Codex support MCP, but MCP is strictly request-response. There's no notification system, no way to push a message into a running session. One agent can call the other as a tool, but the other can't talk back until asked.

A2A (Google's Agent-to-Agent protocol) would be the right solution, but neither Claude Code nor Codex supports it natively. The community bridges that exist just wrap A2A in MCP anyway, adding complexity without solving the fundamental problem.

This bridge uses the only push mechanism available (Claude Code channels) and turns a blocking tool call into the equivalent of push on the Codex side. It's the simplest working solution given what these tools actually support today.

## License

MIT
