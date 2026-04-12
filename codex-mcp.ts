#!/usr/bin/env bun
/**
 * Codex Bridge — MCP server for the Codex CLI side (multi-room).
 *
 * Runs as an MCP server that Codex CLI connects to.
 * Add to Codex's MCP config:
 *   [mcp_servers.codex-bridge]
 *   command = "bun"
 *   args = ["/path/to/codex-claude-bridge/codex-mcp.ts"]
 *   env = { CODEX_BRIDGE_ROOM = "ENG-1234" }
 *
 * Or set CODEX_BRIDGE_ROOM before launching:
 *   CODEX_BRIDGE_ROOM=ENG-1234 codex --full-auto
 *
 * Tools:
 *   send_to_claude(message) — Send a message to Claude. Blocks until Claude replies (~2 min max).
 *   check_claude_messages() — Check if Claude has sent any proactive messages.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const TOTAL_WAIT_MS = 110000
const POLL_SLICE_MS = 15000
const POLL_ABORT_GRACE_MS = 3000

// Codex strips most env vars when spawning MCP servers (only HOME/LANG/PATH survive).
// Fallback: covering-bridge starts Codex via `sh -c 'printf "roomId:token" > /tmp/codex-bridge-room-$$; exec codex'`.
// Because exec replaces sh without changing PID, $$ == the node-wrapper PID.
// codex-mcp.ts traverses: process.ppid (codex binary) → its PPID (node wrapper) → reads the file.
function getRoomAndTokenFromPidFile(): { roomId: string; token: string } {
  try {
    const codexBinaryPid = process.ppid
    const nodeWrapperPid = parseInt(
      execFileSync('ps', ['-o', 'ppid=', '-p', String(codexBinaryPid)], { timeout: 2000 })
        .toString().trim(),
      10,
    )
    if (!nodeWrapperPid || isNaN(nodeWrapperPid)) return { roomId: '', token: '' }
    const content = readFileSync(`/tmp/codex-bridge-room-${nodeWrapperPid}`, 'utf8').trim()
    const idx = content.indexOf(':')
    if (idx === -1) return { roomId: content, token: '' }
    return { roomId: content.slice(0, idx), token: content.slice(idx + 1) }
  } catch {
    return { roomId: '', token: '' }
  }
}

const { roomId: pidFileRoom } = getRoomAndTokenFromPidFile()
const ROOM_ID = process.env.CODEX_BRIDGE_ROOM || pidFileRoom

if (!ROOM_ID) {
  process.stderr.write(
    'codex-mcp: room not found — set CODEX_BRIDGE_ROOM or use covering-bridge to open rooms\n',
  )
  process.exit(1)
}

const BASE = `${BRIDGE_URL}/api/rooms/${encodeURIComponent(ROOM_ID)}`

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const inFlightMessages = new Map<string, Promise<ToolResult>>()

function normalizeMessage(message: string) {
  return message.trim().replace(/\s+/g, ' ')
}

function formatElapsedMs(startMs: number) {
  return `${Math.round((Date.now() - startMs) / 1000)}s`
}

const mcp = new Server(
  { name: `codex-bridge-client:${ROOM_ID}`, version: '0.3.0' },
  { capabilities: { tools: {} } },
)

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'send_to_claude',
      description: [
        `Send a message to Claude Code through Codex Bridge (room: ${ROOM_ID}) and wait for a reply.`,
        'This tool blocks until Claude responds (up to about 2 minutes).',
        'Use this to collaborate with Claude: ask questions, propose approaches,',
        'debate architecture decisions, or reach consensus on implementation details.',
        '',
        'IMPORTANT: This is a conversation tool. If Claude replies with a question,',
        'a counter-proposal, or consensus has not been reached, call this tool AGAIN.',
        'Keep calling it until you and Claude have fully resolved the topic.',
        'Do not call this tool concurrently with the same message.',
        'If it times out, do not immediately resend the exact same prompt.',
      ].join(' '),
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', description: 'The message to send to Claude' },
        },
        required: ['message'],
      },
    },
    {
      name: 'check_claude_messages',
      description: [
        'Check if Claude has sent any proactive messages in this room.',
        'Returns pending messages from Claude that you have not seen yet.',
      ].join(' '),
      inputSchema: { type: 'object', properties: {} },
    },
  ],
}))

mcp.setRequestHandler(CallToolRequestSchema, async req => {
  const args = (req.params.arguments ?? {}) as Record<string, unknown>

  try {
    switch (req.params.name) {
      case 'send_to_claude': {
        const message = args.message as string
        if (!message?.trim()) {
          return { content: [{ type: 'text', text: 'error: empty message' }], isError: true }
        }

        const normalized = normalizeMessage(message)
        const existing = inFlightMessages.get(normalized)
        if (existing) return await existing

        const requestPromise: Promise<ToolResult> = (async () => {
          const startedAt = Date.now()

          // Send message to bridge
          const sendRes = await fetch(`${BASE}/from-codex`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message: message.trim() }),
          })

          if (!sendRes.ok) {
            const err = await sendRes.text()
            return {
              content: [{ type: 'text', text: `error sending to bridge: ${sendRes.status} ${err}` }],
              isError: true,
            }
          }

          const { id } = await sendRes.json() as { id: string }

          // Poll in short slices to avoid transport-layer timeouts
          while (Date.now() - startedAt < TOTAL_WAIT_MS) {
            const remainingMs = TOTAL_WAIT_MS - (Date.now() - startedAt)
            const pollTimeoutMs = Math.min(POLL_SLICE_MS, remainingMs)
            const controller = new AbortController()
            const clientTimeout = setTimeout(() => controller.abort(), pollTimeoutMs + POLL_ABORT_GRACE_MS)
            let pollRes: Response

            try {
              pollRes = await fetch(
                `${BASE}/poll-reply/${id}?timeout=${pollTimeoutMs}`,
                { signal: controller.signal },
              )
            } catch (e: unknown) {
              clearTimeout(clientTimeout)
              const msg = e instanceof Error ? e.message : String(e)
              if (msg.includes('abort') || msg.includes('socket')) continue
              throw e
            }
            clearTimeout(clientTimeout)

            if (!pollRes.ok) {
              const errText = await pollRes.text()
              return {
                content: [{ type: 'text', text: `error polling reply: ${pollRes.status} ${errText}` }],
                isError: true,
              }
            }

            const result = await pollRes.json() as { timeout: boolean; reply: string | null }

            if (result.reply) {
              return { content: [{ type: 'text', text: result.reply }] }
            }

            if (!result.timeout) {
              return {
                content: [{
                  type: 'text',
                  text: `Claude returned no reply after ${formatElapsedMs(startedAt)}. Do not immediately resend the same prompt.`,
                }],
              }
            }
          }

          return {
            content: [{
              type: 'text',
              text: `Claude did not reply within ${formatElapsedMs(startedAt)}. Do not immediately resend the same prompt.`,
            }],
          }
        })()

        inFlightMessages.set(normalized, requestPromise)
        try {
          return await requestPromise
        } finally {
          if (inFlightMessages.get(normalized) === requestPromise) {
            inFlightMessages.delete(normalized)
          }
        }
      }

      case 'check_claude_messages': {
        const res = await fetch(`${BASE}/pending-for-codex`)
        if (!res.ok) {
          return {
            content: [{ type: 'text', text: `error checking messages: ${res.status}` }],
            isError: true,
          }
        }
        const { messages } = await res.json() as { messages: { id: string; text: string }[] }
        if (messages.length === 0) {
          return { content: [{ type: 'text', text: 'No pending messages from Claude.' }] }
        }
        const formatted = messages.map(m => `[${m.id}] ${m.text}`).join('\n\n---\n\n')
        return { content: [{ type: 'text', text: `${messages.length} message(s) from Claude:\n\n${formatted}` }] }
      }

      default:
        return { content: [{ type: 'text', text: `unknown tool: ${req.params.name}` }], isError: true }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (msg.includes('ECONNREFUSED') || msg.includes('fetch failed')) {
      return {
        content: [{
          type: 'text',
          text: `Cannot reach Codex Bridge at ${BRIDGE_URL}. Make sure bridge-server.ts is running.`,
        }],
        isError: true,
      }
    }
    return { content: [{ type: 'text', text: `error: ${msg}` }], isError: true }
  }
})

const HEARTBEAT_INTERVAL_MS = 3000

async function heartbeat() {
  try {
    const res = await fetch(`${BASE}/codex/heartbeat`, { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (res.status === 404) {
      process.stderr.write(`[codex-mcp] room ${ROOM_ID} closed — exiting\n`)
      process.exit(0)
    }
  } catch {}
}

async function unregister() {
  try {
    await fetch(`${BASE}/codex/heartbeat`, { method: 'DELETE', signal: AbortSignal.timeout(3000) })
  } catch {}
}

process.on('exit', () => { void unregister() })
process.on('SIGINT', () => { void unregister().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { void unregister().finally(() => process.exit(0)) })

await mcp.connect(new StdioServerTransport())
await heartbeat()  // immediate ✓ on connect
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)  // keep alive every 30s
process.stderr.write(`codex-bridge-client: ready  room=${ROOM_ID}  bridge=${BRIDGE_URL}\n`)
