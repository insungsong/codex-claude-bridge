#!/usr/bin/env bun
/**
 * Codex Bridge — Central HTTP server for multi-room support.
 *
 * Manages multiple isolated rooms (identified by ticket number e.g. ENG-1234).
 * Each room has its own Codex ↔ assistant message channel.
 *
 * claude-mcp.ts or codex-peer.ts connects here per room to relay messages to/from
 * the assistant slot.
 * codex-mcp.ts connects here per room to relay messages to/from Codex.
 * covering-bridge.ts uses GET /api/rooms to show room status.
 */

import { writeFileSync, mkdirSync, readFileSync, renameSync, existsSync, appendFileSync } from 'node:fs'
import { homedir } from 'os'
import { join, extname } from 'path'
import { randomBytes } from 'node:crypto'
import type { ServerWebSocket } from 'bun'

import {
  normalizeBridgeMessage,
  validateBridgeTextPayload,
} from './bridge-message-payload'
import {
  createReplyProgress,
  formatReplyProgressStatus,
  markReplyCompleted,
  markReplyDelivered,
  markReplyInProgress,
  serializeReplyProgress,
  type ReplyProgress,
  type ReplyProgressSnapshot,
} from './bridge-reply-progress'

const PORT = Number(process.env.CODEX_BRIDGE_PORT ?? 8788)
const STATE_FILE = process.env.CODEX_BRIDGE_STATE_FILE ?? '/tmp/codex-bridge-state.json'
const PERSIST_VERSION = 1
const STALE_CUTOFF_MS = 60 * 60 * 1000  // 1 hour
const PERSIST_DEBOUNCE_MS = 500
const STATE_DIR = join(homedir(), '.claude', 'channels', 'codex-bridge')
const FILES_DIR = join(STATE_DIR, 'files')

// ── Types ──

type AssistantType = 'claude' | 'codex'

type Msg = {
  id: string
  from: 'assistant' | 'codex' | 'user'
  text: string
  ts: number
  replyTo?: string
  file?: { url: string; name: string }
}

type Wire =
  | ({ type: 'msg' } & Msg)
  | { type: 'edit'; id: string; text: string }
  | { type: 'connected'; roomId: string }

type ReplyWaiter = {
  resolve: (response: Response) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

type PendingReply = {
  createdAt: number
  normalizedMessage?: string
  progress: ReplyProgress
  reply?: string
  replyDeliveredAt?: number
  waiters: Set<ReplyWaiter>
}

type ClaudeWaiter = {
  resolve: (response: Response) => void
  timer: ReturnType<typeof setTimeout>
  cleanup: () => void
}

// If no heartbeat/poll within this window, consider the agent disconnected.
const HEARTBEAT_TIMEOUT_MS = 3000  // 3× the 1s heartbeat interval

type RoomState = {
  id: string
  createdAt: number
  assistantType: AssistantType
  // Session token — generated on room creation, written into PID files by covering-bridge.
  // MCP processes must echo it in every heartbeat. Stale processes (wrong/no token) get 404.
  // Liveness: updated by the assistant lane's pending-for-claude poll and codex-mcp's heartbeat.
  // assistantConnected/codexConnected are computed dynamically — not stored as booleans.
  claudeLastSeen: number
  codexLastSeen: number
  lastActivity: number
  // Codex → Claude reply tracking
  pendingReplies: Map<string, PendingReply>
  inFlightCodexMessages: Map<string, string>
  // Claude → Codex proactive queue
  pendingForCodex: { id: string; text: string }[]
  // Codex → Claude delivery queue (polled by claude-mcp.ts)
  pendingForClaude: { id: string; text: string; sender: string; replyTo?: string }[]
  pendingForClaudeWaiters: Set<ClaudeWaiter>
  readonly sessionToken: string
  // WebSocket clients for this room's web UI
  clients: Set<ServerWebSocket<unknown>>
}

type SerializedPendingReply = {
  msgId: string
  createdAt: number
  normalizedMessage?: string
  progress?: ReplyProgress
  reply?: string
  replyDeliveredAt?: number
}

type SerializedRoom = {
  id: string
  createdAt: number
  assistantType?: AssistantType
  sessionToken: string
  lastActivity: number
  pendingForCodex: { id: string; text: string }[]
  pendingReplies: SerializedPendingReply[]
}

type PersistedState = {
  version: number
  savedAt: number
  rooms: SerializedRoom[]
}

function isClaudeConnected(room: RoomState) {
  return room.claudeLastSeen > 0 && (Date.now() - room.claudeLastSeen) < HEARTBEAT_TIMEOUT_MS
}

function isAssistantConnected(room: RoomState) {
  return isClaudeConnected(room)
}

function isCodexConnected(room: RoomState) {
  return room.codexLastSeen > 0 && (Date.now() - room.codexLastSeen) < HEARTBEAT_TIMEOUT_MS
}

function assistantLaneLabel(room: Pick<RoomState, 'assistantType'>) {
  return room.assistantType === 'codex' ? 'codex-peer' : 'claude'
}

function assistantReplyName(room: Pick<RoomState, 'assistantType'>) {
  return room.assistantType === 'codex' ? 'Codex peer' : 'Claude'
}

function parseAssistantType(value: unknown): AssistantType | null {
  if (value === undefined) return 'claude'
  if (value === 'claude' || value === 'codex') return value
  return null
}

type AssistantTypeRequest = {
  assistantType: AssistantType
  explicit: boolean
}

async function readAssistantTypeFromRequest(req: Request): Promise<AssistantTypeRequest | null> {
  const raw = await req.text()
  if (!raw.trim()) {
    return {
      assistantType: 'claude',
      explicit: false,
    }
  }

  try {
    const parsed = JSON.parse(raw) as { assistantType?: unknown }
    const assistantType = parseAssistantType(parsed.assistantType)
    if (!assistantType) return null
    return {
      assistantType,
      explicit: parsed.assistantType !== undefined,
    }
  } catch {
    return null
  }
}

// ── Room registry ──

const rooms = new Map<string, RoomState>()
loadState()

// Tombstone: roomIds deleted within the last 10s. Prevents zombie MCP processes from
// instantly reviving a room after [c] closes it. Expires automatically after 10s,
// allowing the user to manually reopen the same room ID again.
const recentlyDeleted = new Map<string, number>()
function markDeleted(roomId: string) {
  recentlyDeleted.set(roomId, Date.now())
  setTimeout(() => recentlyDeleted.delete(roomId), 10000)
}
function isTombstoned(roomId: string) {
  const ts = recentlyDeleted.get(roomId)
  return ts !== undefined && Date.now() - ts < 10000
}

function getOrCreateRoom(roomId: string, assistantType: AssistantType = 'claude'): RoomState {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      createdAt: Date.now(),
      assistantType,
      claudeLastSeen: 0,
      codexLastSeen: 0,
      lastActivity: Date.now(),
      pendingReplies: new Map(),
      inFlightCodexMessages: new Map(),
      pendingForCodex: [],
      pendingForClaude: [],
      pendingForClaudeWaiters: new Set(),
      sessionToken: randomBytes(16).toString('hex'),
      clients: new Set(),
    })
    process.stderr.write(`[bridge] room created: ${roomId}\n`)
    schedulePersist()
  }
  return rooms.get(roomId)!
}

function touchRoom(room: RoomState) {
  room.lastActivity = Date.now()
}

// ── Persistence ──

function serializeRoom(room: RoomState): SerializedRoom {
  const serializedReplies: SerializedPendingReply[] = []
  for (const [msgId, pending] of room.pendingReplies) {
    serializedReplies.push({
      msgId,
      createdAt: pending.createdAt,
      normalizedMessage: pending.normalizedMessage,
      progress: pending.progress,
      reply: pending.reply,
      replyDeliveredAt: pending.replyDeliveredAt,
    })
  }
  return {
    id: room.id,
    createdAt: room.createdAt,
    assistantType: room.assistantType,
    sessionToken: room.sessionToken,
    lastActivity: room.lastActivity,
    pendingForCodex: [...room.pendingForCodex],
    pendingReplies: serializedReplies,
  }
}

let persistTimer: Timer | null = null

function persistState(): void {
  persistTimer = null
  try {
    const state: PersistedState = {
      version: PERSIST_VERSION,
      savedAt: Date.now(),
      rooms: Array.from(rooms.values()).map(serializeRoom),
    }
    writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[bridge] persist failed: ${msg}\n`)
  }
}

function schedulePersist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(persistState, PERSIST_DEBOUNCE_MS)
}

function loadState(): void {
  if (!existsSync(STATE_FILE)) return
  let raw: string
  try {
    raw = readFileSync(STATE_FILE, 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[bridge] state read failed: ${msg}\n`)
    return
  }
  let parsed: PersistedState
  try {
    parsed = JSON.parse(raw) as PersistedState
  } catch {
    const corruptPath = `${STATE_FILE}.corrupted-${Date.now()}`
    try { renameSync(STATE_FILE, corruptPath) } catch {}
    process.stderr.write(`[bridge] state file corrupt; moved to ${corruptPath}\n`)
    return
  }
  if (parsed.version !== PERSIST_VERSION) {
    process.stderr.write(`[bridge] state version ${parsed.version} != ${PERSIST_VERSION}, skipping\n`)
    return
  }
  const now = Date.now()
  let restored = 0
  let skipped = 0
  for (const sr of parsed.rooms) {
    if (now - sr.lastActivity > STALE_CUTOFF_MS) {
      skipped++
      continue
    }
    const pendingReplies = new Map<string, PendingReply>()
    for (const sp of sr.pendingReplies) {
      // Drop entries with no reply — the Codex that was waiting has already timed out.
      if (sp.reply === undefined) continue
      const progress = sp.progress ?? createReplyProgress(sp.createdAt)
      markReplyCompleted(progress, sp.createdAt)
      pendingReplies.set(sp.msgId, {
        createdAt: sp.createdAt,
        normalizedMessage: sp.normalizedMessage,
        progress,
        reply: sp.reply,
        replyDeliveredAt: sp.replyDeliveredAt,
        waiters: new Set(),
      })
    }
    rooms.set(sr.id, {
      id: sr.id,
      createdAt: sr.createdAt,
      assistantType: sr.assistantType ?? 'claude',
      claudeLastSeen: 0,
      codexLastSeen: 0,
      lastActivity: sr.lastActivity,
      pendingReplies,
      inFlightCodexMessages: new Map(),
      pendingForCodex: [...sr.pendingForCodex],
      pendingForClaude: [],
      pendingForClaudeWaiters: new Set(),
      sessionToken: sr.sessionToken,
      clients: new Set(),
    })
    restored++
  }
  process.stderr.write(`[bridge] state loaded: ${restored} room(s) restored, ${skipped} stale\n`)
}

// ── Message history log ──

const LOG_DIR = process.env.CODEX_BRIDGE_LOG_DIR ?? '/tmp'

function sanitizeRoomIdForPath(roomId: string): string {
  // Defense-in-depth: block path traversal characters even though roomId is trusted
  return roomId.replace(/[^\w.-]/g, '_')
}

function logMessage(
  roomId: string,
  kind: string,
  id: string,
  sender: string,
  text: string,
): void {
  try {
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      roomId,
      kind,
      id,
      sender,
      text,
    }) + '\n'
    const path = `${LOG_DIR}/bridge-${sanitizeRoomIdForPath(roomId)}.jsonl`
    // appendFileSync is fine for dev-scale traffic
    appendFileSync(path, line, 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[bridge] log failed: ${msg}\n`)
  }
}

// ── Utilities ──

let seq = 0
function nextId(prefix = 'm') {
  return `${prefix}${Date.now()}-${++seq}`
}

function mime(ext: string) {
  const m: Record<string, string> = {
    '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
    '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
    '.pdf': 'application/pdf', '.txt': 'text/plain',
  }
  return m[ext] ?? 'application/octet-stream'
}

function broadcast(room: RoomState, m: Wire) {
  const data = JSON.stringify(m)
  for (const ws of room.clients) if (ws.readyState === 1) ws.send(data)
}

// ── Reply routing (Codex waits for Claude) ──

const MAX_PENDING_REPLY_MS = 10 * 60 * 1000
const REPLIED_PENDING_REPLY_GRACE_MS = 2 * 60 * 1000

function dropPendingReply(room: RoomState, msgId: string) {
  const pending = room.pendingReplies.get(msgId)
  if (!pending) return
  room.pendingReplies.delete(msgId)
  if (pending.normalizedMessage && room.inFlightCodexMessages.get(pending.normalizedMessage) === msgId) {
    room.inFlightCodexMessages.delete(pending.normalizedMessage)
  }
  for (const w of pending.waiters) w.cleanup()
  pending.waiters.clear()
  schedulePersist()
}

function listActiveReplyStatuses(room: RoomState) {
  const statuses: ReplyProgressSnapshot[] = []
  for (const [msgId, pending] of room.pendingReplies) {
    if (pending.progress.state === 'replied') continue
    statuses.push(serializeReplyProgress(msgId, pending.progress))
  }
  return statuses
}

function markDeliveredMessages(room: RoomState, messages: Array<{ id: string; sender: string }>) {
  let changed = false
  for (const message of messages) {
    if (message.sender !== 'codex') continue
    const pending = room.pendingReplies.get(message.id)
    if (!pending) continue
    if (pending.progress.state === 'queued') changed = true
    markReplyDelivered(pending.progress)
  }
  if (changed) schedulePersist()
}

function pruneExpiredPendingReplies(room: RoomState) {
  const now = Date.now()
  for (const [msgId, pending] of room.pendingReplies) {
    if (
      pending.reply !== undefined &&
      pending.replyDeliveredAt !== undefined &&
      now - pending.replyDeliveredAt > REPLIED_PENDING_REPLY_GRACE_MS
    ) {
      dropPendingReply(room, msgId)
      continue
    }
    if (now - pending.createdAt > MAX_PENDING_REPLY_MS) dropPendingReply(room, msgId)
  }
}

function resolveCodexReply(room: RoomState, replyToId: string | undefined, text: string) {
  if (!replyToId) return
  const pending = room.pendingReplies.get(replyToId)
  if (!pending || pending.reply !== undefined) return
  pending.reply = text
  markReplyCompleted(pending.progress)
  if (pending.waiters.size > 0) {
    const waiters = Array.from(pending.waiters)
    pending.waiters.clear()
    pending.replyDeliveredAt = Date.now()
    schedulePersist()
    for (const w of waiters) w.cleanup()
    for (const w of waiters) w.resolve(Response.json({ timeout: false, reply: text }))
    return
  }
  schedulePersist()
}

function drainLateRepliesForCodex(room: RoomState) {
  const late: { id: string; text: string }[] = []
  for (const [msgId, pending] of room.pendingReplies) {
    if (pending.reply === undefined) continue
    late.push({ id: msgId, text: pending.reply })
    dropPendingReply(room, msgId)
  }
  return late
}

// ── Claude-side delivery (claude-mcp.ts polls this) ──

function deliverMessageToClaude(
  room: RoomState,
  id: string,
  text: string,
  sender: string,
  replyTo?: string,
) {
  room.pendingForClaude.push({ id, text, sender, replyTo })
  if (room.pendingForClaudeWaiters.size > 0) {
    const messages = room.pendingForClaude.splice(0)
    markDeliveredMessages(room, messages)
    const waiters = Array.from(room.pendingForClaudeWaiters)
    room.pendingForClaudeWaiters.clear()
    for (const w of waiters) w.resolve(Response.json({ messages }))
  }
}

// ── Token authorization ──

function checkToken(req: Request, room: RoomState): Response | null {
  const provided = req.headers.get('x-bridge-token')
  if (!provided || provided !== room.sessionToken) {
    process.stderr.write(`[bridge] auth rejected: roomId=${room.id}\n`)
    return Response.json({ error: 'bad token' }, { status: 401 })
  }
  return null
}

// ── HTTP server ──

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  async fetch(req, server) {
    const url = new URL(req.url)
    const path = url.pathname

    // WebSocket upgrade — /ws/:roomId
    // NOTE: WebSocket path still uses getOrCreateRoom — token gating for WS
    // handshakes requires a query-string token (no custom headers available in
    // browser upgrade requests) and is deferred to a later task. Phantom room
    // creation via /ws/:roomId is a known gap, not addressed in P0 session-token.
    if (path.startsWith('/ws/') && req.headers.get('upgrade') === 'websocket') {
      const roomId = decodeURIComponent(path.slice(4))
      if (!roomId) return new Response('missing room', { status: 400 })
      getOrCreateRoom(roomId)
      if (server.upgrade(req, { data: { roomId } })) return
      return new Response('upgrade failed', { status: 400 })
    }

    // File serving
    if (path.startsWith('/files/')) {
      const f = path.slice(7)
      if (f.includes('..') || f.includes('/')) return new Response('bad', { status: 400 })
      try {
        return new Response(readFileSync(join(FILES_DIR, f)), {
          headers: { 'content-type': mime(extname(f).toLowerCase()) },
        })
      } catch { return new Response('404', { status: 404 }) }
    }

    // ── GET /api/rooms — room list ──
    if (path === '/api/rooms' && req.method === 'GET') {
      const list = Array.from(rooms.values()).map(r => ({
        id: r.id,
        createdAt: r.createdAt,
        assistantType: r.assistantType,
        assistantConnected: isAssistantConnected(r),
        claudeConnected: r.assistantType === 'claude' && isAssistantConnected(r),
        codexConnected: isCodexConnected(r),
        lastActivity: r.lastActivity,
      }))
      return Response.json(list)
    }

    // ── POST /api/rooms/:roomId — pre-create room (called by covering-bridge) ──
    // ── DELETE /api/rooms/:roomId — close room ──
    const closeMatch = path.match(/^\/api\/rooms\/([^/]+)$/)
    if (closeMatch && req.method === 'POST') {
      const roomId = decodeURIComponent(closeMatch[1])
      const assistantRequest = await readAssistantTypeFromRequest(req)
      if (!assistantRequest) {
        return Response.json({ error: 'assistantType must be "claude" or "codex"' }, { status: 400 })
      }
      const had = rooms.has(roomId)
      const room = getOrCreateRoom(roomId, assistantRequest.assistantType)
      if (had && assistantRequest.explicit && room.assistantType !== assistantRequest.assistantType) {
        room.assistantType = assistantRequest.assistantType
        touchRoom(room)
        schedulePersist()
      }
      return Response.json(
        {
          sessionToken: room.sessionToken,
          assistantType: room.assistantType,
        },
        { status: had ? 200 : 201 },
      )
    }
    if (closeMatch && req.method === 'DELETE') {
      const roomId = decodeURIComponent(closeMatch[1])
      const room = rooms.get(roomId)
      if (!room) return Response.json({ error: 'room not found' }, { status: 404 })
      for (const w of room.pendingForClaudeWaiters) w.resolve(Response.json({ messages: [] }))
      for (const [, pending] of room.pendingReplies) {
        for (const w of pending.waiters) w.resolve(Response.json({ timeout: true, reply: null }))
      }
      rooms.delete(roomId)
      markDeleted(roomId)  // tombstone: block auto-create for 10s
      schedulePersist()
      process.stderr.write(`[bridge] room closed: ${roomId}\n`)
      return new Response(null, { status: 204 })
    }

    // ── Health check ──
    if (path === '/api/health') {
      return Response.json({ status: 'ok', port: PORT, rooms: rooms.size })
    }

    // ── Web UI ──
    if (path === '/') {
      return new Response(HTML, { headers: { 'content-type': 'text/html; charset=utf-8' } })
    }

    // ── Room-scoped endpoints: /api/rooms/:roomId/... ──
    const roomMatch = path.match(/^\/api\/rooms\/([^/]+)\/(.+)$/)
    if (!roomMatch) return new Response('404', { status: 404 })

    const roomId = decodeURIComponent(roomMatch[1])
    const sub = roomMatch[2]

    // Assistant connect — room must exist (legitimate clients POST /api/rooms/:id first)
    // Endpoint name stays Claude-specific for backward compatibility with claude-mcp.ts.
    // Order: isTombstoned → rooms.get+404 → checkToken → business logic
    if (sub === 'claude/connect') {
      if (req.method === 'POST') {
        if (isTombstoned(roomId)) return new Response(null, { status: 404 })
        const room = rooms.get(roomId)
        if (!room) return new Response('room not found', { status: 404 })
        const authFail = checkToken(req, room)
        if (authFail) return authFail
        room.claudeLastSeen = Date.now()
        touchRoom(room)
        process.stderr.write(`[bridge] ${assistantLaneLabel(room)} connected: ${roomId}\n`)
        return new Response(null, { status: 204 })
      }
      if (req.method === 'DELETE') {
        const room = rooms.get(roomId)
        if (!room) return new Response('room not found', { status: 404 })
        const authFail = checkToken(req, room)
        if (authFail) return authFail
        room.claudeLastSeen = 0
        touchRoom(room)
        process.stderr.write(`[bridge] ${assistantLaneLabel(room)} disconnected: ${roomId}\n`)
        return new Response(null, { status: 204 })
      }
    }

    // Codex heartbeat/connect — room must exist (legitimate clients POST /api/rooms/:id first)
    // Order: isTombstoned → rooms.get+404 → checkToken → business logic
    if (sub === 'codex/heartbeat' || sub === 'codex/connect') {
      if (req.method === 'POST') {
        if (isTombstoned(roomId)) return new Response(null, { status: 404 })
        const room = rooms.get(roomId)
        if (!room) return new Response('room not found', { status: 404 })
        const authFail = checkToken(req, room)
        if (authFail) return authFail
        room.codexLastSeen = Date.now()
        touchRoom(room)
        return new Response(null, { status: 204 })
      }
      if (req.method === 'DELETE') {
        const room = rooms.get(roomId)
        if (!room) return new Response('room not found', { status: 404 })
        const authFail = checkToken(req, room)
        if (authFail) return authFail
        room.codexLastSeen = 0
        touchRoom(room)
        return new Response(null, { status: 204 })
      }
    }

    // GET /api/rooms/:roomId/pending-for-claude — assistant lane long-polls
    // Endpoint name stays Claude-specific for backward compatibility.
    if (sub === 'pending-for-claude' && req.method === 'GET') {
      const room = rooms.get(roomId)
      if (!room) return Response.json({ error: 'room not found' }, { status: 404 })
      const authFail = checkToken(req, room)
      if (authFail) return authFail
      room.claudeLastSeen = Date.now()  // each poll = heartbeat for assistant-lane liveness
      touchRoom(room)
      const timeout = Number(url.searchParams.get('timeout') ?? 30000)

      if (room.pendingForClaude.length > 0) {
        const messages = room.pendingForClaude.splice(0)
        markDeliveredMessages(room, messages)
        return Response.json({ messages })
      }

      return new Promise<Response>(resolve => {
        let waiter: ClaudeWaiter
        const onAbort = () => {
          room.pendingForClaudeWaiters.delete(waiter)
          waiter.cleanup()
          resolve(Response.json({ messages: [] }))
        }
        waiter = {
          resolve,
          timer: setTimeout(() => {
            room.pendingForClaudeWaiters.delete(waiter)
            waiter.cleanup()
            resolve(Response.json({ messages: [] }))
          }, Math.min(timeout, 60000)),
          cleanup: () => {
            clearTimeout(waiter.timer)
            req.signal.removeEventListener('abort', onAbort)
          },
        }
        req.signal.addEventListener('abort', onAbort, { once: true })
        room.pendingForClaudeWaiters.add(waiter)
      })
    }

    // POST /api/rooms/:roomId/from-claude — assistant lane sends reply/proactive
    // Endpoint name stays Claude-specific for backward compatibility.
    if (sub === 'from-claude' && req.method === 'POST') {
      return (async () => {
        const room = rooms.get(roomId)
        if (!room) return Response.json({ error: 'room not found' }, { status: 404 })
        const authFail = checkToken(req, room)
        if (authFail) return authFail
        touchRoom(room)
        const body = await req.json() as { text: string; replyTo?: string; proactive?: boolean }
        const { replyTo, proactive } = body
        const validation = validateBridgeTextPayload(body.text)
        if (validation.ok === false) {
          return Response.json({ error: validation.error }, { status: 400 })
        }

        const text = validation.text
        const id = nextId('claude-')
        broadcast(room, { type: 'msg', id, from: 'assistant', text, ts: Date.now(), replyTo })
        if (proactive) {
          room.pendingForCodex.push({ id, text })
          schedulePersist()
        } else {
          resolveCodexReply(room, replyTo, text)
        }
        const assistantLabel = assistantLaneLabel(room)
        logMessage(
          roomId,
          proactive ? `${assistantLabel}→codex:proactive` : `${assistantLabel}→codex:reply`,
          id,
          assistantLabel,
          text,
        )
        return Response.json({ id })
      })()
    }

    // POST /api/rooms/:roomId/from-codex — Codex sends to the assistant lane
    // rooms.get + 404: prevents phantom room creation on unauthenticated HTTP gate calls
    // (note: /ws/:roomId upgrade path still auto-creates — see upgrade handler)
    if (sub === 'from-codex' && req.method === 'POST') {
      return (async () => {
        const room = rooms.get(roomId)
        if (!room) return new Response('room not found', { status: 404 })
        const authFail = checkToken(req, room)
        if (authFail) return authFail
        touchRoom(room)
        pruneExpiredPendingReplies(room)

        const body = await req.json() as { message: string }
        const validation = validateBridgeTextPayload(body.message)
        if (validation.ok === false) {
          return new Response(validation.error, { status: 400 })
        }

        const message = validation.text

        const normalized = normalizeBridgeMessage(message)
        const existingId = room.inFlightCodexMessages.get(normalized)
        if (existingId && room.pendingReplies.has(existingId)) {
          return Response.json({ id: existingId })
        }
        if (existingId) room.inFlightCodexMessages.delete(normalized)

        const id = nextId('codex-')
        room.pendingReplies.set(id, {
          createdAt: Date.now(),
          normalizedMessage: normalized,
          progress: createReplyProgress(),
          waiters: new Set(),
        })
        room.inFlightCodexMessages.set(normalized, id)
        schedulePersist()

        deliverMessageToClaude(room, id, message, 'codex')
        broadcast(room, { type: 'msg', id, from: 'codex', text: message, ts: Date.now() })
        logMessage(roomId, `codex→${assistantLaneLabel(room)}`, id, 'codex', message)
        return Response.json({ id })
      })()
    }

    const progressMatch = sub.match(/^reply-progress\/(.+)$/)
    if (progressMatch && req.method === 'POST') {
      return (async () => {
        const room = rooms.get(roomId)
        if (!room) return Response.json({ error: 'room not found' }, { status: 404 })
        const authFail = checkToken(req, room)
        if (authFail) return authFail
        touchRoom(room)

        const pending = room.pendingReplies.get(progressMatch[1])
        if (!pending) return Response.json({ error: 'reply not found' }, { status: 404 })

        const body = await req.json() as { note?: string }
        markReplyInProgress(pending.progress, body.note)
        schedulePersist()

        return Response.json({
          ok: true,
          assistantLabel: assistantLaneLabel(room),
          assistantName: assistantReplyName(room),
          status: {
            ...serializeReplyProgress(progressMatch[1], pending.progress),
            summary: formatReplyProgressStatus(pending.progress, Date.now(), assistantReplyName(room)),
          },
        })
      })()
    }

    const statusMatch = sub.match(/^reply-status\/(.+)$/)
    if (statusMatch && req.method === 'GET') {
      const room = rooms.get(roomId)
      if (!room) return Response.json({ found: false }, { status: 404 })
      const authFail = checkToken(req, room)
      if (authFail) return authFail
      touchRoom(room)

      const pending = room.pendingReplies.get(statusMatch[1])
      if (!pending) return Response.json({ found: false }, { status: 404 })

      return Response.json({
        found: true,
        peerAlive: isAssistantConnected(room),
        assistantLabel: assistantLaneLabel(room),
        assistantName: assistantReplyName(room),
        status: {
          ...serializeReplyProgress(statusMatch[1], pending.progress),
          summary: formatReplyProgressStatus(pending.progress, Date.now(), assistantReplyName(room)),
        },
      })
    }

    // POST /api/rooms/:roomId/ack-reply/:id — Codex confirms it received a reply
    const ackMatch = sub.match(/^ack-reply\/(.+)$/)
    if (ackMatch && req.method === 'POST') {
      const room = rooms.get(roomId)
      if (!room) return Response.json({ error: 'room not found' }, { status: 404 })
      const authFail = checkToken(req, room)
      if (authFail) return authFail
      touchRoom(room)

      const pending = room.pendingReplies.get(ackMatch[1])
      if (!pending || pending.reply === undefined) {
        return Response.json({ ok: true, acknowledged: false })
      }

      dropPendingReply(room, ackMatch[1])
      return Response.json({ ok: true, acknowledged: true })
    }

    // GET /api/rooms/:roomId/poll-reply/:id — Codex long-polls for Claude's reply
    const pollMatch = sub.match(/^poll-reply\/(.+)$/)
    if (pollMatch && req.method === 'GET') {
      const room = rooms.get(roomId)
      if (!room) return Response.json({ error: 'room not found' }, { status: 404 })
      const authFail = checkToken(req, room)
      if (authFail) return authFail
      pruneExpiredPendingReplies(room)
      touchRoom(room)

      const msgId = pollMatch[1]
      const timeout = Number(url.searchParams.get('timeout') ?? 120000)
      const pending = room.pendingReplies.get(msgId)

      if (!pending) return Response.json({ timeout: true, reply: null })
      if (pending.reply !== undefined) {
        const reply = pending.reply
        dropPendingReply(room, msgId)
        return Response.json({ timeout: false, reply })
      }

      return new Promise<Response>(resolve => {
        let waiter: ReplyWaiter
        const onAbort = () => {
          pending.waiters.delete(waiter)
          waiter.cleanup()
          resolve(Response.json({ timeout: true, reply: null }))
        }
        waiter = {
          resolve,
          timer: setTimeout(() => {
            pending.waiters.delete(waiter)
            waiter.cleanup()
            resolve(Response.json({ timeout: true, reply: null }))
          }, Math.min(timeout, 300000)),
          cleanup: () => {
            clearTimeout(waiter.timer)
            req.signal.removeEventListener('abort', onAbort)
          },
        }
        req.signal.addEventListener('abort', onAbort, { once: true })
        pending.waiters.add(waiter)
      })
    }

    // GET /api/rooms/:roomId/pending-for-codex
    if (sub === 'pending-for-codex' && req.method === 'GET') {
      const room = rooms.get(roomId)
      if (!room) return Response.json({ error: 'room not found' }, { status: 404 })
      const authFail = checkToken(req, room)
      if (authFail) return authFail
      pruneExpiredPendingReplies(room)
      touchRoom(room)
      const messages = [...room.pendingForCodex.splice(0), ...drainLateRepliesForCodex(room)]
      const statuses = listActiveReplyStatuses(room).map(status => ({
        ...status,
        summary: formatReplyProgressStatus(status, Date.now(), assistantReplyName(room)),
      }))
      return Response.json({
        messages,
        statuses,
        assistantLabel: assistantLaneLabel(room),
        assistantName: assistantReplyName(room),
      })
    }

    // POST /api/rooms/:roomId/upload — file upload from web UI
    if (sub === 'upload' && req.method === 'POST') {
      return (async () => {
        const room = rooms.get(roomId)
        if (!room) return Response.json({ error: 'room not found' }, { status: 404 })
        const form = await req.formData()
        const id = String(form.get('id') ?? '')
        const text = String(form.get('text') ?? '')
        const f = form.get('file')
        if (!id) return new Response('missing id', { status: 400 })
        let fileInfo: { url: string; name: string } | undefined
        if (f instanceof File && f.size > 0) {
          if (f.size > 50 * 1024 * 1024) return new Response('file too large', { status: 413 })
          const ext = extname(f.name).toLowerCase() || '.bin'
          const fname = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`
          writeFileSync(join(FILES_DIR, fname), Buffer.from(await f.arrayBuffer()))
          fileInfo = { url: `/files/${fname}`, name: f.name }
        }
        const msgId = nextId('user-')
        broadcast(room, { type: 'msg', id: msgId, from: 'user', text, ts: Date.now(), file: fileInfo })
        deliverMessageToClaude(room, msgId, text, 'user')
        return new Response(null, { status: 204 })
      })()
    }

    return new Response('404', { status: 404 })
  },

  websocket: {
    open(ws) {
      const { roomId } = ws.data as { roomId: string }
      const room = getOrCreateRoom(roomId)
      room.clients.add(ws)
      ws.send(JSON.stringify({ type: 'connected', roomId }))
    },
    close(ws) {
      const { roomId } = ws.data as { roomId: string }
      const room = rooms.get(roomId)
      if (room) room.clients.delete(ws)
    },
    message(ws, raw) {
      try {
        const { roomId } = ws.data as { roomId: string }
        const room = rooms.get(roomId)
        if (!room) return
        const { id, text } = JSON.parse(String(raw)) as { id: string; text: string }
        if (id && text?.trim()) {
          deliverMessageToClaude(room, id, text.trim(), 'user')
        }
      } catch {}
    },
  },
})

mkdirSync(FILES_DIR, { recursive: true })
process.stderr.write(`[bridge] http://localhost:${PORT}  (multi-room)\n`)

// ── Web UI ──
// Uses safe DOM APIs (createElement/textContent/appendChild) — no innerHTML with dynamic data.

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Codex Bridge</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0a0a0a; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
  header { padding: 12px 20px; background: #111; border-bottom: 1px solid #222; display: flex; align-items: center; gap: 10px; }
  .logo { width: 28px; height: 28px; background: linear-gradient(135deg, #00d4aa, #7b61ff); border-radius: 6px; display: flex; align-items: center; justify-content: center; font-weight: 700; font-size: 12px; color: #fff; }
  h1 { font-size: 15px; font-weight: 600; color: #fff; }
  #room-select { margin-left: auto; background: #1a1a1a; border: 1px solid #333; color: #e0e0e0; padding: 4px 10px; border-radius: 6px; font-size: 13px; }
  .status { font-size: 12px; color: #555; display: flex; align-items: center; gap: 6px; }
  .dot { width: 8px; height: 8px; border-radius: 50%; background: #333; flex-shrink: 0; }
  .dot.on { background: #00d4aa; }
  #log { flex: 1; overflow-y: auto; padding: 20px; display: flex; flex-direction: column; gap: 14px; }
  .message { max-width: 78%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; word-break: break-word; }
  .message .label { font-size: 10px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 4px; opacity: 0.8; }
  .message.assistant { align-self: flex-start; border-bottom-left-radius: 4px; }
  .message.assistant.claude { background: #1a1528; border: 1px solid #2d2245; }
  .message.assistant.claude .label { color: #b490ff; }
  .message.assistant.codex-peer { background: #161b28; border: 1px solid #24314a; }
  .message.assistant.codex-peer .label { color: #7ec8ff; }
  .message.codex { align-self: flex-end; background: #0d1f1a; border: 1px solid #1a3d30; border-bottom-right-radius: 4px; }
  .message.codex .label { color: #00d4aa; }
  .message.user { align-self: flex-start; background: #1a1a1a; border: 1px solid #2a2a2a; margin-left: 40px; }
  .message.user .label { color: #888; }
  .message .meta { font-size: 11px; opacity: 0.5; margin-top: 4px; }
  .hint { text-align: center; font-size: 12px; color: #333; padding: 20px; }
  #input-area { padding: 14px 20px; background: #111; border-top: 1px solid #222; }
  #form { display: flex; gap: 10px; align-items: flex-end; }
  #text { flex: 1; background: #1a1a1a; border: 1px solid #333; border-radius: 10px; color: #e0e0e0; font-family: inherit; font-size: 14px; padding: 10px 14px; resize: none; outline: none; min-height: 42px; max-height: 120px; }
  #text:focus { border-color: #7b61ff; }
  #text::placeholder { color: #555; }
  button.send { background: linear-gradient(135deg, #00d4aa, #7b61ff); color: #fff; font-weight: 600; padding: 8px 16px; border-radius: 10px; border: none; cursor: pointer; }
  button.send:disabled { opacity: 0.3; cursor: default; }
  #log::-webkit-scrollbar { width: 6px; }
  #log::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
</style>
</head>
<body>
<header>
  <div class="logo">CB</div>
  <h1>Codex Bridge</h1>
  <select id="room-select"></select>
  <div class="status">
    <div class="dot" id="dot"></div>
    <span id="status-text">disconnected</span>
  </div>
</header>
<div id="log"></div>
<div id="input-area">
  <form id="form">
    <textarea id="text" rows="1" placeholder="Message (as human observer)..." autocomplete="off"></textarea>
    <button type="submit" class="send" id="send-btn" disabled>Send</button>
  </form>
</div>
<script>
const log = document.getElementById('log')
const form = document.getElementById('form')
const text = document.getElementById('text')
const sendBtn = document.getElementById('send-btn')
const dot = document.getElementById('dot')
const statusText = document.getElementById('status-text')
const roomSelect = document.getElementById('room-select')

let currentRoom = null
let ws = null
let uid = 0
const roomMeta = new Map()

function roomAssistantClass(roomId) {
  const assistantType = roomMeta.get(roomId)?.assistantType
  return assistantType === 'codex' ? 'codex-peer' : 'claude'
}

function roomAssistantLabel(roomId) {
  const assistantType = roomMeta.get(roomId)?.assistantType
  return assistantType === 'codex' ? 'Codex peer' : 'Claude'
}

async function loadRooms() {
  let data = []
  try { data = await fetch('/api/rooms').then(r => r.json()) } catch { return }
  const prev = roomSelect.value
  roomMeta.clear()
  while (roomSelect.firstChild) roomSelect.removeChild(roomSelect.firstChild)
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = data.length === 0 ? 'no rooms yet' : '— select room —'
  roomSelect.appendChild(placeholder)
  for (const r of data) {
    roomMeta.set(r.id, { assistantType: r.assistantType || 'claude' })
    const o = document.createElement('option')
    o.value = r.id
    const both = r.assistantConnected && r.codexConnected
    const one = r.assistantConnected || r.codexConnected
    o.textContent = r.id + (both ? ' \u2713' : one ? ' ~' : ' \u25cb')
    roomSelect.appendChild(o)
  }
  if (prev) roomSelect.value = prev
}

function clearLog() {
  while (log.firstChild) log.removeChild(log.firstChild)
}

function switchRoom(roomId) {
  if (ws) { ws.close(); ws = null }
  currentRoom = roomId
  clearLog()
  sendBtn.disabled = true
  if (!roomId) {
    dot.classList.remove('on')
    statusText.textContent = 'disconnected'
    return
  }
  connect(roomId)
}

function connect(roomId) {
  statusText.textContent = 'connecting...'
  ws = new WebSocket('ws://' + location.host + '/ws/' + encodeURIComponent(roomId))
  ws.onopen = () => {
    dot.classList.add('on')
    statusText.textContent = roomId + ' active'
    sendBtn.disabled = !text.value.trim()
  }
  ws.onclose = () => {
    dot.classList.remove('on')
    sendBtn.disabled = true
    statusText.textContent = 'reconnecting...'
    if (currentRoom === roomId) setTimeout(() => connect(roomId), 2000)
  }
  ws.onmessage = e => {
    try {
      const m = JSON.parse(e.data)
      if (m.type === 'msg') addMsg(m)
    } catch {}
  }
}

roomSelect.addEventListener('change', () => switchRoom(roomSelect.value))

form.addEventListener('submit', e => {
  e.preventDefault()
  if (!currentRoom || !ws || ws.readyState !== 1) return
  const msg = text.value.trim()
  if (!msg) return
  text.value = ''
  text.style.height = 'auto'
  sendBtn.disabled = true
  ws.send(JSON.stringify({ id: 'u' + Date.now() + '-' + (++uid), text: msg }))
})

text.addEventListener('input', () => {
  text.style.height = 'auto'
  text.style.height = Math.min(text.scrollHeight, 120) + 'px'
  sendBtn.disabled = !text.value.trim() || !currentRoom || !ws || ws.readyState !== 1
})

text.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit() }
})

function addMsg(m) {
  const wrap = document.createElement('div')
  if (m.from === 'assistant') {
    wrap.className = 'message assistant ' + roomAssistantClass(currentRoom)
  } else {
    wrap.className = 'message ' + m.from
  }

  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = m.from === 'assistant'
    ? roomAssistantLabel(currentRoom)
    : m.from === 'codex'
      ? 'Codex'
      : 'You'
  wrap.appendChild(label)

  const body = document.createElement('div')
  body.textContent = m.text || ''
  wrap.appendChild(body)

  const meta = document.createElement('div')
  meta.className = 'meta'
  meta.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  wrap.appendChild(meta)

  log.appendChild(wrap)
  log.scrollTop = log.scrollHeight
}

loadRooms()
setInterval(loadRooms, 5000)
</script>
</body>
</html>
`
