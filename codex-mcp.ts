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

import {
  normalizeBridgeMessage,
  validateBridgeTextPayload,
} from './bridge-message-payload'
import { formatReplyProgressStatus, type ReplyProgressSnapshot } from './bridge-reply-progress'
import { DEFAULT_REPLY_WAIT_POLICY, shouldKeepWaitingForReply } from './reply-wait-policy'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const POLL_SLICE_MS = 15000
const POLL_ABORT_GRACE_MS = 3000

const REPLY_WAIT_POLICY = (() => {
  const override = Number(process.env.CODEX_BRIDGE_MAX_WAIT_MS)
  if (!Number.isFinite(override) || override <= 0) return DEFAULT_REPLY_WAIT_POLICY
  return { ...DEFAULT_REPLY_WAIT_POLICY, maxWaitMs: override }
})()

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

const { roomId: pidFileRoom, token: pidFileToken } = getRoomAndTokenFromPidFile()
const ROOM_ID = process.env.CODEX_BRIDGE_ROOM || pidFileRoom
const BRIDGE_TOKEN = process.env.CODEX_BRIDGE_TOKEN || pidFileToken

if (!ROOM_ID) {
  process.stderr.write(
    'codex-mcp: room not found — set CODEX_BRIDGE_ROOM or use bridge-codex to open rooms\n',
  )
  process.exit(1)
}

if (!BRIDGE_TOKEN) {
  process.stderr.write(
    'codex-mcp: session token not found — use bridge-codex wrapper or set CODEX_BRIDGE_TOKEN\n',
  )
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
  process.stderr.write(`[codex-mcp] ${where} returned ${status} — exiting\n`)
  process.exit(0)
}

function exitOnAuthFail(status: number, where: string): void {
  if (status === 401 || status === 404) failAuth(status, where)
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

type ReplyStatusInfo = {
  status: ReplyProgressSnapshot & { summary?: string }
  peerAlive: boolean
}

const inFlightMessages = new Map<string, Promise<ToolResult>>()

function formatElapsedMs(startMs: number) {
  return `${Math.round((Date.now() - startMs) / 1000)}s`
}

function formatTimeoutMessage(startMs: number, info?: ReplyStatusInfo) {
  const elapsed = formatElapsedMs(startMs)

  if (info?.peerAlive && info.status.state !== 'replied') {
    const summary = info.status.summary ?? formatReplyProgressStatus(info.status)
    return [
      `Claude 세션은 여전히 연결되어 있고 ${elapsed} 동안 작업 중입니다.`,
      summary,
      '같은 본문을 재전송하지 마세요. 잠시 후 `check_claude_messages`로 답변을 확인하거나 진행 상황을 다시 문의하세요.',
    ].join(' ')
  }

  if (!info) {
    return `${elapsed} 동안 Claude로부터 응답이 없었습니다. 같은 본문을 즉시 재전송하지 마세요.`
  }

  const summary = info.status.summary ?? formatReplyProgressStatus(info.status)
  return `${elapsed} 동안 Claude가 최종 답변을 내지 않았습니다. ${summary} 같은 본문을 즉시 재전송하지 마세요.`
}

async function fetchReplyStatus(id: string): Promise<ReplyStatusInfo | null> {
  const res = await bridgeFetch(`/reply-status/${id}`)
  exitOnAuthFail(res.status, 'send_to_claude/reply-status')
  if (!res.ok) return null
  const data = await res.json() as {
    found: boolean
    peerAlive?: boolean
    status?: ReplyProgressSnapshot & { summary?: string }
  }
  if (!data.found || !data.status) return null
  return { status: data.status, peerAlive: data.peerAlive ?? false }
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
        'For tiny relays or short pings, send the real non-empty message directly instead of doing unrelated preflight checks first.',
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
        'Use this after a real handoff or when explicitly checking pending proactive messages.',
        'Do not use it as a preflight step before the first non-empty send_to_claude call.',
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
        const validation = validateBridgeTextPayload(args.message)
        if (validation.ok === false) {
          return { content: [{ type: 'text', text: `error: ${validation.error}` }], isError: true }
        }

        const message = validation.text
        const normalized = normalizeBridgeMessage(message)
        const existing = inFlightMessages.get(normalized)
        if (existing) return await existing

        const requestPromise: Promise<ToolResult> = (async () => {
          const startedAt = Date.now()

          // Send message to bridge
          const sendRes = await bridgeFetch('/from-codex', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ message }),
          })
          exitOnAuthFail(sendRes.status, 'send_to_claude/from-codex')

          if (!sendRes.ok) {
            const err = await sendRes.text()
            return {
              content: [{ type: 'text', text: `error sending to bridge: ${sendRes.status} ${err}` }],
              isError: true,
            }
          }

          const { id } = await sendRes.json() as { id: string }

          // Poll in short slices to avoid transport-layer timeouts
          while (true) {
            const elapsedMs = Date.now() - startedAt
            if (elapsedMs >= REPLY_WAIT_POLICY.maxWaitMs) break

            const remainingMs = REPLY_WAIT_POLICY.maxWaitMs - elapsedMs
            const pollTimeoutMs = Math.min(POLL_SLICE_MS, remainingMs)
            const controller = new AbortController()
            const clientTimeout = setTimeout(() => controller.abort(), pollTimeoutMs + POLL_ABORT_GRACE_MS)
            let pollRes: Response

            try {
              pollRes = await bridgeFetch(
                `/poll-reply/${id}?timeout=${pollTimeoutMs}`,
                { signal: controller.signal },
              )
            } catch (e: unknown) {
              clearTimeout(clientTimeout)
              const msg = e instanceof Error ? e.message : String(e)
              if (msg.includes('abort') || msg.includes('socket')) continue
              throw e
            }
            clearTimeout(clientTimeout)
            exitOnAuthFail(pollRes.status, 'send_to_claude/poll-reply')

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
                  text: `${formatElapsedMs(startedAt)} 동안 Claude가 빈 응답을 반환했습니다. 같은 본문을 즉시 재전송하지 마세요.`,
                }],
              }
            }

            const replyStatus = await fetchReplyStatus(id)
            if (!shouldKeepWaitingForReply(
              startedAt,
              replyStatus?.status,
              undefined,
              REPLY_WAIT_POLICY,
              replyStatus?.peerAlive ?? false,
            )) {
              return {
                content: [{
                  type: 'text',
                  text: formatTimeoutMessage(startedAt, replyStatus ?? undefined),
                }],
              }
            }
          }

          const replyStatus = await fetchReplyStatus(id)
          return {
            content: [{
              type: 'text',
              text: formatTimeoutMessage(startedAt, replyStatus ?? undefined),
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
        const res = await bridgeFetch('/pending-for-codex')
        exitOnAuthFail(res.status, 'check_claude_messages')
        if (!res.ok) {
          return {
            content: [{ type: 'text', text: `error checking messages: ${res.status}` }],
            isError: true,
          }
        }
        const {
          messages,
          statuses = [],
        } = await res.json() as {
          messages: { id: string; text: string }[]
          statuses?: Array<ReplyProgressSnapshot & { summary?: string }>
        }
        if (messages.length === 0 && statuses.length === 0) {
          return { content: [{ type: 'text', text: 'No pending messages from Claude.' }] }
        }
        const sections: string[] = []
        if (messages.length > 0) {
          const formattedMessages = messages.map(m => `[${m.id}] ${m.text}`).join('\n\n---\n\n')
          sections.push(`${messages.length} message(s) from Claude:\n\n${formattedMessages}`)
        }
        if (statuses.length > 0) {
          const formattedStatuses = statuses
            .map(status => `[${status.id}] ${status.summary ?? formatReplyProgressStatus(status)}`)
            .join('\n\n---\n\n')
          sections.push(`Active Claude work:\n\n${formattedStatuses}`)
        }
        return { content: [{ type: 'text', text: sections.join('\n\n===\n\n') }] }
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

const HEARTBEAT_INTERVAL_MS = 1000

// Codex MCP runs in its own process group (PGID = self), so it never receives
// SIGHUP when the Codex parent exits. Poll the parent PID directly instead.
function isParentAlive(): boolean {
  try { process.kill(process.ppid!, 0); return true } catch { return false }
}

async function heartbeat() {
  if (!isParentAlive()) {
    process.stderr.write(`[codex-mcp] parent gone — exiting\n`)
    await unregister()
    process.exit(0)
  }
  try {
    const res = await bridgeFetch('/codex/heartbeat', { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (res.status === 401 || res.status === 404) {
      process.stderr.write(`[codex-mcp] room ${ROOM_ID} closed — exiting\n`)
      process.exit(0)
    }
  } catch {}
}

async function unregister() {
  try {
    await bridgeFetch('/codex/heartbeat', { method: 'DELETE', signal: AbortSignal.timeout(3000) })
  } catch {}
}

process.on('exit', () => { void unregister() })
process.on('SIGINT', () => { void unregister().finally(() => process.exit(0)) })
process.on('SIGTERM', () => { void unregister().finally(() => process.exit(0)) })

await mcp.connect(new StdioServerTransport())
await heartbeat()  // immediate ✓ on connect
setInterval(heartbeat, HEARTBEAT_INTERVAL_MS)  // keep alive every 30s
process.stderr.write(`codex-bridge-client: ready  room=${ROOM_ID}  bridge=${BRIDGE_URL}\n`)
