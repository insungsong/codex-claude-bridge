#!/usr/bin/env bun
/**
 * Codex Bridge — Central HTTP server for multi-room support.
 *
 * Manages multiple isolated rooms (identified by ticket number e.g. ENG-1234).
 * Each room has its own Codex ↔ Claude message channel.
 *
 * claude-mcp.ts connects here per room to relay messages to/from Claude.
 * codex-mcp.ts connects here per room to relay messages to/from Codex.
 * covering-bridge.ts uses GET /api/rooms to show room status.
 */

import { writeFileSync, mkdirSync } from 'fs'
import { readFileSync } from 'fs'
import { homedir } from 'os'
import { join, extname } from 'path'
import type { ServerWebSocket } from 'bun'

const PORT = Number(process.env.CODEX_BRIDGE_PORT ?? 8788)
const STATE_DIR = join(homedir(), '.claude', 'channels', 'codex-bridge')
const FILES_DIR = join(STATE_DIR, 'files')

// ── Types ──

type Msg = {
  id: string
  from: 'claude' | 'codex' | 'user'
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
  reply?: string
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
  // Session token — generated on room creation, written into PID files by covering-bridge.
  // MCP processes must echo it in every heartbeat. Stale processes (wrong/no token) get 404.
  // Liveness: updated by claude-mcp's pending-for-claude poll and codex-mcp's heartbeat.
  // claudeConnected/codexConnected are computed dynamically — not stored as booleans.
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
  // WebSocket clients for this room's web UI
  clients: Set<ServerWebSocket<unknown>>
}

function isClaudeConnected(room: RoomState) {
  return room.claudeLastSeen > 0 && (Date.now() - room.claudeLastSeen) < HEARTBEAT_TIMEOUT_MS
}

function isCodexConnected(room: RoomState) {
  return room.codexLastSeen > 0 && (Date.now() - room.codexLastSeen) < HEARTBEAT_TIMEOUT_MS
}

// ── Room registry ──

const rooms = new Map<string, RoomState>()

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

function getOrCreateRoom(roomId: string): RoomState {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      id: roomId,
      createdAt: Date.now(),
      claudeLastSeen: 0,
      codexLastSeen: 0,
      lastActivity: Date.now(),
      pendingReplies: new Map(),
      inFlightCodexMessages: new Map(),
      pendingForCodex: [],
      pendingForClaude: [],
      pendingForClaudeWaiters: new Set(),
      clients: new Set(),
    })
    process.stderr.write(`[bridge] room created: ${roomId}\n`)
  }
  return rooms.get(roomId)!
}

function touchRoom(room: RoomState) {
  room.lastActivity = Date.now()
}

// ── Utilities ──

let seq = 0
function nextId(prefix = 'm') {
  return `${prefix}${Date.now()}-${++seq}`
}

function normalizeMessage(message: string) {
  return message.trim().replace(/\s+/g, ' ')
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

function dropPendingReply(room: RoomState, msgId: string) {
  const pending = room.pendingReplies.get(msgId)
  if (!pending) return
  room.pendingReplies.delete(msgId)
  if (pending.normalizedMessage && room.inFlightCodexMessages.get(pending.normalizedMessage) === msgId) {
    room.inFlightCodexMessages.delete(pending.normalizedMessage)
  }
  for (const w of pending.waiters) w.cleanup()
  pending.waiters.clear()
}

function pruneExpiredPendingReplies(room: RoomState) {
  const now = Date.now()
  for (const [msgId, pending] of room.pendingReplies) {
    if (now - pending.createdAt > MAX_PENDING_REPLY_MS) dropPendingReply(room, msgId)
  }
}

function resolveCodexReply(room: RoomState, replyToId: string | undefined, text: string) {
  if (!replyToId) return
  const pending = room.pendingReplies.get(replyToId)
  if (!pending || pending.reply !== undefined) return
  pending.reply = text
  if (pending.waiters.size > 0) {
    const waiters = Array.from(pending.waiters)
    dropPendingReply(room, replyToId)
    for (const w of waiters) w.resolve(Response.json({ timeout: false, reply: text }))
  }
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
    const waiters = Array.from(room.pendingForClaudeWaiters)
    room.pendingForClaudeWaiters.clear()
    for (const w of waiters) w.resolve(Response.json({ messages }))
  }
}

// ── HTTP server ──

Bun.serve({
  port: PORT,
  hostname: '127.0.0.1',
  fetch(req, server) {
    const url = new URL(req.url)
    const path = url.pathname

    // WebSocket upgrade — /ws/:roomId
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
        claudeConnected: isClaudeConnected(r),
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
      getOrCreateRoom(roomId)
      return new Response(null, { status: 201 })
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

    // Claude connect — auto-creates room on first heartbeat (unless tombstoned)
    if (sub === 'claude/connect') {
      if (req.method === 'POST') {
        if (isTombstoned(roomId)) return new Response(null, { status: 404 })
        const room = getOrCreateRoom(roomId)
        room.claudeLastSeen = Date.now()
        touchRoom(room)
        process.stderr.write(`[bridge] claude connected: ${roomId}\n`)
        return new Response(null, { status: 204 })
      }
      if (req.method === 'DELETE') {
        const room = rooms.get(roomId)
        if (room) { room.claudeLastSeen = 0; touchRoom(room) }
        process.stderr.write(`[bridge] claude disconnected: ${roomId}\n`)
        return new Response(null, { status: 204 })
      }
    }

    // Codex heartbeat — auto-creates room on first heartbeat (unless tombstoned)
    if (sub === 'codex/heartbeat' || sub === 'codex/connect') {
      if (req.method === 'POST') {
        if (isTombstoned(roomId)) return new Response(null, { status: 404 })
        const room = getOrCreateRoom(roomId)
        room.codexLastSeen = Date.now()
        touchRoom(room)
        return new Response(null, { status: 204 })
      }
      if (req.method === 'DELETE') {
        const room = rooms.get(roomId)
        if (room) { room.codexLastSeen = 0; touchRoom(room) }
        return new Response(null, { status: 204 })
      }
    }

    // GET /api/rooms/:roomId/pending-for-claude — claude-mcp.ts long-polls
    if (sub === 'pending-for-claude' && req.method === 'GET') {
      const room = rooms.get(roomId)
      if (!room) return Response.json({ error: 'room not found' }, { status: 404 })
      room.claudeLastSeen = Date.now()  // each poll = heartbeat for Claude liveness
      touchRoom(room)
      const timeout = Number(url.searchParams.get('timeout') ?? 30000)

      if (room.pendingForClaude.length > 0) {
        return Response.json({ messages: room.pendingForClaude.splice(0) })
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

    // POST /api/rooms/:roomId/from-claude — claude-mcp.ts sends reply/proactive
    if (sub === 'from-claude' && req.method === 'POST') {
      return (async () => {
        const room = rooms.get(roomId)
        if (!room) return Response.json({ error: 'room not found' }, { status: 404 })
        touchRoom(room)
        const body = await req.json() as { text: string; replyTo?: string; proactive?: boolean }
        const { text, replyTo, proactive } = body
        const id = nextId('claude-')
        broadcast(room, { type: 'msg', id, from: 'claude', text, ts: Date.now(), replyTo })
        if (proactive) {
          room.pendingForCodex.push({ id, text })
        } else {
          resolveCodexReply(room, replyTo, text)
        }
        return Response.json({ id })
      })()
    }

    // POST /api/rooms/:roomId/from-codex — Codex sends to Claude
    if (sub === 'from-codex' && req.method === 'POST') {
      return (async () => {
        const room = getOrCreateRoom(roomId)
        touchRoom(room)
        pruneExpiredPendingReplies(room)

        const body = await req.json() as { message: string }
        const message = body.message?.trim()
        if (!message) return new Response('missing message', { status: 400 })

        const normalized = normalizeMessage(message)
        const existingId = room.inFlightCodexMessages.get(normalized)
        if (existingId && room.pendingReplies.has(existingId)) {
          return Response.json({ id: existingId })
        }
        if (existingId) room.inFlightCodexMessages.delete(normalized)

        const id = nextId('codex-')
        room.pendingReplies.set(id, {
          createdAt: Date.now(),
          normalizedMessage: normalized,
          waiters: new Set(),
        })
        room.inFlightCodexMessages.set(normalized, id)

        deliverMessageToClaude(room, id, message, 'codex')
        broadcast(room, { type: 'msg', id, from: 'codex', text: message, ts: Date.now() })
        return Response.json({ id })
      })()
    }

    // GET /api/rooms/:roomId/poll-reply/:id — Codex long-polls for Claude's reply
    const pollMatch = sub.match(/^poll-reply\/(.+)$/)
    if (pollMatch && req.method === 'GET') {
      const room = rooms.get(roomId)
      if (!room) return Response.json({ timeout: true, reply: null })
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
      if (!room) return Response.json({ messages: [] })
      pruneExpiredPendingReplies(room)
      touchRoom(room)
      const messages = [...room.pendingForCodex.splice(0), ...drainLateRepliesForCodex(room)]
      return Response.json({ messages })
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
  .message.claude { align-self: flex-start; background: #1a1528; border: 1px solid #2d2245; border-bottom-left-radius: 4px; }
  .message.claude .label { color: #b490ff; }
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

async function loadRooms() {
  let data = []
  try { data = await fetch('/api/rooms').then(r => r.json()) } catch { return }
  const prev = roomSelect.value
  while (roomSelect.firstChild) roomSelect.removeChild(roomSelect.firstChild)
  const placeholder = document.createElement('option')
  placeholder.value = ''
  placeholder.textContent = data.length === 0 ? 'no rooms yet' : '— select room —'
  roomSelect.appendChild(placeholder)
  for (const r of data) {
    const o = document.createElement('option')
    o.value = r.id
    const both = r.claudeConnected && r.codexConnected
    const one = r.claudeConnected || r.codexConnected
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
  wrap.className = 'message ' + m.from

  const label = document.createElement('div')
  label.className = 'label'
  label.textContent = m.from === 'claude' ? 'Claude' : m.from === 'codex' ? 'Codex' : 'You'
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
