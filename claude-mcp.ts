#!/usr/bin/env bun
/**
 * Codex Bridge — Claude-side MCP relay.
 *
 * Runs as Claude Code's channel plugin (stdio MCP server).
 * Connects to bridge-server.ts via HTTP to relay messages.
 *
 * Required env vars:
 *   CODEX_BRIDGE_ROOM  — room ID, e.g. "ENG-1234"
 *   CODEX_BRIDGE_URL   — bridge server URL (default: http://localhost:8788)
 *
 * Flow:
 *   Codex → bridge-server → pending-for-claude → [this polls] → mcp.notification → Claude
 *   Claude → reply tool → [this] → POST /from-claude → bridge-server → Codex poll
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'

import { validateBridgeTextPayload } from './bridge-message-payload'

// Claude Code strips env vars when spawning MCP servers.
// Workaround: covering-bridge runs `sh -c 'printf "roomId" > /tmp/claude-bridge-room-$$; exec claude ...'`
// exec replaces sh with node-claude, keeping the same PID (X).
// We try reading the file at each level of the PPID chain until we find it.
function readPidFile(pid: number): string {
  try {
    return readFileSync(`/tmp/claude-bridge-room-${pid}`, 'utf8').trim()
  } catch {
    return ''
  }
}

function getParentPid(pid: number): number {
  try {
    return parseInt(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(pid)], { timeout: 2000 }).toString().trim(),
      10,
    )
  } catch {
    return 0
  }
}

function getRoomAndTokenFromPidFile(): { roomId: string; token: string } {
  // Walk up 3 levels of the process tree to find the PID file
  let pid = process.ppid ?? 0
  for (let i = 0; i < 3; i++) {
    if (!pid || isNaN(pid)) break
    const content = readPidFile(pid)
    if (content) {
      const idx = content.indexOf(':')
      if (idx === -1) return { roomId: content, token: '' }
      return { roomId: content.slice(0, idx), token: content.slice(idx + 1) }
    }
    pid = getParentPid(pid)
  }
  return { roomId: '', token: '' }
}

const { roomId: pidFileRoom, token: pidFileToken } = getRoomAndTokenFromPidFile()
const ROOM_ID = process.env.CODEX_BRIDGE_ROOM || pidFileRoom
const BRIDGE_TOKEN = process.env.CODEX_BRIDGE_TOKEN || pidFileToken
const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const POLL_TIMEOUT_MS = 30000
const POLL_BACKOFF_MS = 1000


if (!ROOM_ID) {
  process.stderr.write('claude-mcp: CODEX_BRIDGE_ROOM env var is required\n')
  process.exit(1)
}

if (!BRIDGE_TOKEN) {
  process.stderr.write('claude-mcp: session token not found — use bridge-claude wrapper or set CODEX_BRIDGE_TOKEN\n')
  process.exit(1)
}

const BASE = `${BRIDGE_URL}/api/rooms/${encodeURIComponent(ROOM_ID)}`
const AUTH_HEADERS = { 'x-bridge-token': BRIDGE_TOKEN } as const

function mergeHeaders(base?: HeadersInit): Record<string, string> {
  if (!base) return { ...AUTH_HEADERS }
  if (base instanceof Headers) {
    const out: Record<string, string> = {}
    base.forEach((v, k) => { out[k] = v })
    return { ...out, ...AUTH_HEADERS }
  }
  if (Array.isArray(base)) {
    return { ...Object.fromEntries(base), ...AUTH_HEADERS }
  }
  return { ...(base as Record<string, string>), ...AUTH_HEADERS }
}

async function bridgeFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: mergeHeaders(init?.headers),
  })
}

function failAuth(status: number, where: string): never {
  process.stderr.write(`[claude-mcp] ${where} returned ${status} — exiting\n`)
  process.exit(0)
}

function exitOnAuthFail(status: number, where: string): void {
  if (status === 401 || status === 404) failAuth(status, where)
}

// ── MCP server ──

const mcp = new Server(
  { name: `codex-bridge:${ROOM_ID}`, version: '0.3.0' },
  {
    capabilities: { tools: {}, experimental: { 'claude/channel': {} } },
    instructions: [
      `You are connected to Codex Bridge, room ${ROOM_ID}.`,
      'Messages from Codex arrive as <channel source="codex-bridge" sender="codex" message_id="..." ...>.',
      'The message_id attribute in the channel tag is what you pass as reply_to.',
      'If a Codex request will take more than a quick answer, call mark_in_progress with the message_id before starting the longer work.',
      'Reply with the reply tool. ALWAYS pass reply_to with the message_id — critical for routing.',
      `Web UI: ${BRIDGE_URL}`,
    ].join('\n'),
  },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'reply',
      description: `Send a reply through Codex Bridge (room: ${ROOM_ID}). Pass reply_to with the message_id so the response routes back to Codex.`,
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string' },
          reply_to: { type: 'string', description: 'message_id of the message being replied to' },
        },
        required: ['text', 'reply_to'],
      },
    },
    {
      name: 'send_to_codex',
      description: 'Proactively send a message to Codex without waiting for Codex to ask first.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'Message to send to Codex' },
        },
        required: ['text'],
      },
    },
    {
      name: 'mark_in_progress',
      description: 'Mark a Codex request as actively in progress so Codex can distinguish long-running work from silence.',
      inputSchema: {
        type: 'object',
        properties: {
          reply_to: { type: 'string', description: 'message_id of the Codex message being worked on' },
          note: { type: 'string', description: 'Optional short status note, e.g. "running tests"' },
        },
        required: ['reply_to'],
      },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>
  try {
    switch (req.params.name) {
      case 'reply': {
        const replyTo = args.reply_to as string | undefined
        if (!replyTo?.trim()) {
          return { content: [{ type: 'text', text: 'reply: reply_to is required — pass the message_id from the channel notification' }], isError: true }
        }

        const validation = validateBridgeTextPayload(args.text)
        if (validation.ok === false) {
          return { content: [{ type: 'text', text: `reply: ${validation.error}` }], isError: true }
        }

        const text = validation.text
        const res = await bridgeFetch('/from-claude', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, replyTo, proactive: false }),
        })
        exitOnAuthFail(res.status, 'reply/from-claude')
        if (!res.ok) throw new Error(`bridge error: ${res.status}`)
        const { id } = await res.json() as { id: string }
        return { content: [{ type: 'text', text: `sent (${id})` }] }
      }

      case 'send_to_codex': {
        const validation = validateBridgeTextPayload(args.text)
        if (validation.ok === false) {
          return { content: [{ type: 'text', text: `send_to_codex: ${validation.error}` }], isError: true }
        }

        const text = validation.text
        const res = await bridgeFetch('/from-claude', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text, proactive: true }),
        })
        exitOnAuthFail(res.status, 'send_to_codex/from-claude')
        if (!res.ok) throw new Error(`bridge error: ${res.status}`)
        const { id } = await res.json() as { id: string }
        return { content: [{ type: 'text', text: `sent to codex (${id})` }] }
      }

      case 'mark_in_progress': {
        const replyTo = args.reply_to as string | undefined
        if (!replyTo?.trim()) {
          return { content: [{ type: 'text', text: 'mark_in_progress: reply_to is required' }], isError: true }
        }

        const noteValidation = args.note === undefined
          ? null
          : validateBridgeTextPayload(args.note)
        if (noteValidation && noteValidation.ok === false) {
          return { content: [{ type: 'text', text: `mark_in_progress: ${noteValidation.error}` }], isError: true }
        }

        const note = noteValidation?.ok ? noteValidation.text : undefined
        const res = await bridgeFetch(`/reply-progress/${encodeURIComponent(replyTo.trim())}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ note }),
        })
        exitOnAuthFail(res.status, 'mark_in_progress/reply-progress')
        if (!res.ok) throw new Error(`bridge error: ${res.status}`)
        const { status } = await res.json() as { status: { summary?: string } }
        return {
          content: [{
            type: 'text',
            text: `marked in progress${status?.summary ? `: ${status.summary}` : ''}`,
          }],
        }
      }
      default:
        return { content: [{ type: 'text', text: `unknown: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `${req.params.name}: ${err instanceof Error ? err.message : err}` }],
      isError: true,
    }
  }
})

await mcp.connect(new StdioServerTransport())

const CLAUDE_HEARTBEAT_INTERVAL_MS = 1000

async function heartbeat() {
  try {
    const res = await bridgeFetch('/claude/connect', { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (res.status === 401 || res.status === 404) {
      process.stderr.write(`[claude-mcp] room ${ROOM_ID} closed — exiting\n`)
      process.exit(0)
    }
  } catch {}
}

async function unregister() {
  try {
    await bridgeFetch('/claude/connect', { method: 'DELETE', signal: AbortSignal.timeout(3000) })
  } catch {}
}

// Deliver a message from Codex into Claude's session via channel notification
async function deliverToClaude(id: string, text: string, sender: string) {
  await mcp.notification({
    method: 'notifications/claude/channel',
    params: {
      content: text,
      meta: {
        chat_id: `bridge-${ROOM_ID}`,
        message_id: id,
        sender,
        room: ROOM_ID,
        ts: new Date().toISOString(),
      },
    },
  })
}

// Background polling loop — picks up messages from Codex via bridge-server
async function pollLoop() {
  while (true) {
    try {
      const res = await bridgeFetch(
        `/pending-for-claude?timeout=${POLL_TIMEOUT_MS}`,
        { signal: AbortSignal.timeout(POLL_TIMEOUT_MS + 5000) },
      )
      exitOnAuthFail(res.status, 'pollLoop/pending-for-claude')
      if (!res.ok) {
        await Bun.sleep(POLL_BACKOFF_MS)
        continue
      }
      const { messages } = await res.json() as {
        messages: { id: string; text: string; sender: string }[]
      }
      for (const msg of messages) {
        await deliverToClaude(msg.id, msg.text, msg.sender)
      }
    } catch {
      // Bridge unreachable or timeout — back off and retry
      await Bun.sleep(POLL_BACKOFF_MS)
    }
  }
}

// Cleanup on exit
process.on('exit', () => { void unregister() })
process.on('SIGINT', () => { void unregister().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { void unregister().finally(() => process.exit(0)) })

await heartbeat()  // immediate ✓ on connect
setInterval(heartbeat, CLAUDE_HEARTBEAT_INTERVAL_MS)  // keep alive every 10s
process.stderr.write(`[claude-mcp] polling room ${ROOM_ID} at ${BRIDGE_URL}\n`)
void pollLoop()
