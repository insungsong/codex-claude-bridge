#!/usr/bin/env bun
/**
 * covering-bridge — Room manager CLI for the Codex-Claude multi-room bridge.
 */

import { createInterface } from 'readline'
import { spawnSync } from 'child_process'

import { getTerminalSessions, shutdownRoomTerminals } from './room-terminals'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const BRIDGE_DIR = new URL('.', import.meta.url).pathname
const VERSION = 'v0.4'

type Room = {
  id: string
  createdAt: number
  assistantType?: 'claude' | 'codex'
  assistantConnected?: boolean
  claudeConnected: boolean
  codexConnected: boolean
  lastActivity: number
}

// ── ANSI helpers ──

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  bcyan:   '\x1b[96m',
  green:   '\x1b[32m',
  bgreen:  '\x1b[92m',
  purple:  '\x1b[33m',   // orange (256-color fallback: yellow-ish)
  bpurple: '\x1b[38;5;208m',  // bright orange
  yellow:  '\x1b[33m',
  gray:    '\x1b[90m',
  red:     '\x1b[31m',
}

function vis(s: string) { return s.replace(/\x1b\[[0-9;]*m/g, '') }

/** Visual column width, accounting for CJK double-width characters. */
function visWidth(s: string): number {
  let w = 0
  for (const ch of vis(s)) {
    const cp = ch.codePointAt(0) ?? 0
    w += (
      (cp >= 0x1100 && cp <= 0x115F) ||  // Hangul Jamo
      (cp >= 0xAC00 && cp <= 0xD7AF) ||  // Hangul Syllables
      (cp >= 0x4E00 && cp <= 0x9FFF) ||  // CJK Unified
      (cp >= 0x3000 && cp <= 0x303F) ||  // CJK Symbols
      (cp >= 0xFF00 && cp <= 0xFF60)      // Fullwidth Forms
    ) ? 2 : 1
  }
  return w
}

function rpad(s: string, n: number) {
  const diff = n - visWidth(s)
  return diff > 0 ? s + ' '.repeat(diff) : s
}

const BOX = 54
function boxTop()    { return `  ${C.gray}╭${'─'.repeat(BOX)}╮${C.reset}` }
function boxBottom() { return `  ${C.gray}╰${'─'.repeat(BOX)}╯${C.reset}` }
function boxRow(content: string) {
  const pad = BOX - visWidth(content)
  return `  ${C.gray}│${C.reset}${content}${' '.repeat(Math.max(0, pad))}${C.gray}│${C.reset}`
}
function divider() { return `  ${C.gray}${'─'.repeat(BOX)}${C.reset}` }

// ── Bridge server management ──

async function isBridgeRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/rooms`, { signal: AbortSignal.timeout(2000) })
    return res.ok && Array.isArray(await res.json())
  } catch { return false }
}

async function startBridgeServer(): Promise<void> {
  const serverPath = `${BRIDGE_DIR}bridge-server.ts`
  const proc = Bun.spawn(['bun', serverPath], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
  proc.unref()
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(300)
    if (await isBridgeRunning()) return
  }
  throw new Error(`Bridge server did not start. Check: bun ${serverPath}`)
}

async function ensureBridge(): Promise<void> {
  if (await isBridgeRunning()) return
  await startBridgeServer()
}

// ── Room API ──

async function getRooms(): Promise<Room[]> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/rooms`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data as Room[] : []
  } catch { return [] }
}

async function closeRoom(roomId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BRIDGE_URL}/api/rooms/${encodeURIComponent(roomId)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(3000) },
    )
    return res.status === 204
  } catch { return false }
}

// ── Display ──

function formatAge(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000)
  if (secs < 5)    return `${C.bgreen}just now${C.reset}`
  if (secs < 60)   return `${C.gray}${secs}s ago${C.reset}`
  if (secs < 3600) return `${C.gray}${Math.floor(secs / 60)}m ago${C.reset}`
  return `${C.gray}${Math.floor(secs / 3600)}h ago${C.reset}`
}

function agentDot(connected: boolean, onColor: string): string {
  return connected ? `${onColor}●${C.reset}` : `${C.gray}○${C.reset}`
}

function roomAssistantType(room: Room): 'claude' | 'codex' {
  return room.assistantType === 'codex' ? 'codex' : 'claude'
}

function roomAssistantConnected(room: Room): boolean {
  return room.assistantConnected ?? room.claudeConnected
}

function roomAssistantLabel(room: Room): string {
  return roomAssistantType(room) === 'codex' ? 'codex-peer' : 'claude'
}

function roomAssistantColor(room: Room): string {
  return roomAssistantType(room) === 'codex' ? C.bcyan : C.bpurple
}

function parseSelection(pick: string, count: number): number[] {
  return [...new Set(
    pick.split(',')
      .map(s => parseInt(s.trim(), 10) - 1)
      .filter(i => !isNaN(i) && i >= 0 && i < count),
  )]
}

function getTerminalTargets() {
  return [...getTerminalSessions().entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([roomId, sessions]) => ({
      roomId,
      claudeCount: sessions.claude.length,
      codexCount: sessions.codex.length,
      codexPeerCount: sessions.codexPeer.length,
    }))
}

function inferAssistantTypeFromSessions(roomId: string, sessions: ReturnType<typeof getTerminalSessions>): 'claude' | 'codex' | null {
  const session = sessions.get(roomId)
  if (!session) return null
  if (session.codexPeer.length > 0) return 'codex'
  if (session.claude.length > 0) return 'claude'
  return null
}

function displayAssistantType(room: Room, sessions: ReturnType<typeof getTerminalSessions>): 'claude' | 'codex' {
  return inferAssistantTypeFromSessions(room.id, sessions) ?? roomAssistantType(room)
}

function displayAssistantLabel(room: Room, sessions: ReturnType<typeof getTerminalSessions>): string {
  return displayAssistantType(room, sessions) === 'codex' ? 'codex-peer' : 'claude'
}

function displayAssistantColor(room: Room, sessions: ReturnType<typeof getTerminalSessions>): string {
  return displayAssistantType(room, sessions) === 'codex' ? C.bcyan : C.bpurple
}

function terminalSummaryParts(session: { claude: number[]; codex: number[]; codexPeer: number[] }) {
  const parts: string[] = []
  if (session.codexPeer.length > 0) parts.push(`codex-peer ×${session.codexPeer.length}`)
  if (session.claude.length > 0) parts.push(`claude ×${session.claude.length}`)
  if (session.codex.length > 0) parts.push(`codex ×${session.codex.length}`)
  return parts
}

function summarizeShutdown(roomId: string, summary: Awaited<ReturnType<typeof shutdownRoomTerminals>>): string {
  if (summary.matched === 0) {
    return `  ${C.gray}•${C.reset}  ${roomId}: no bridge-launched terminals found.`
  }

  const parts: string[] = []
  if (summary.terminated.length > 0) parts.push(`SIGTERM ${summary.terminated.length}`)
  if (summary.forced.length > 0) parts.push(`SIGKILL ${summary.forced.length}`)
  if (summary.failures.length > 0) parts.push(`failed ${summary.failures.length}`)

  const detail = parts.length > 0 ? parts.join(', ') : 'no-op'
  const tone = summary.failures.length > 0 ? `${C.yellow}•${C.reset}` : `${C.bgreen}•${C.reset}`
  return `  ${tone}  ${roomId}: terminal shutdown ${detail}.`
}

function printRooms(rooms: Room[]): void {
  console.clear()
  console.log()
  const sessions = getTerminalSessions()

  // ── Header ──
  console.log(boxTop())
  console.log(boxRow(`  ${C.bold}${C.bcyan}◈  Codex Bridge${C.reset}  ${C.dim}룸 관리 대시보드${C.reset}  ${C.gray}${VERSION}${C.reset}`))
  console.log(boxRow(`     ${C.dim}multi-room claude/codex-peer bridge${C.reset}`))
  console.log(boxBottom())
  console.log()

  // ── Status ──
  const roomCount = rooms.length === 0
    ? `${C.gray}no active rooms${C.reset}`
    : `${C.bold}${rooms.length}${C.reset} room${rooms.length === 1 ? '' : 's'} active`
  console.log(`  ${roomCount}  ${C.gray}·${C.reset}  ${C.dim}${BRIDGE_URL}${C.reset}`)
  console.log()

  // ── Room list ──
  if (rooms.length === 0) {
    console.log(`  ${C.gray}No rooms yet. Press ${C.reset}${C.bold}o${C.reset}${C.gray} to open one.${C.reset}`)
  } else {
    for (const r of [...rooms].sort((a, b) => a.id.localeCompare(b.id))) {
      const codex  = agentDot(r.codexConnected,  C.bgreen)
      const assistant = agentDot(roomAssistantConnected(r), displayAssistantColor(r, sessions))
      const codexL  = r.codexConnected  ? `${C.green}codex${C.reset}`  : `${C.gray}codex${C.reset}`
      const assistantL = roomAssistantConnected(r)
        ? `${displayAssistantColor(r, sessions)}${displayAssistantLabel(r, sessions)}${C.reset}`
        : `${C.gray}${displayAssistantLabel(r, sessions)}${C.reset}`
      const id  = rpad(`${C.bold}${r.id}${C.reset}`, 14)
      const age = formatAge(r.lastActivity)
      console.log(`  ${id}  ${codex} ${codexL}   ${assistant} ${assistantL}   ${age}`)
    }
  }
  // ── Terminal sessions (dim) ──
  if (sessions.size > 0) {
    const sorted = [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b))
    console.log(`  ${C.dim}terminals${C.reset}`)
    for (const [roomId, s] of sorted) {
      const parts = terminalSummaryParts(s)
      const label = parts.length > 0 ? parts.join('   ') : 'no active terminals'
      console.log(`  ${C.dim}${roomId.padEnd(14)}  ${label}${C.reset}`)
    }
  }
  console.log()

  // ── Footer ──
  console.log(divider())
  const keys = [
    `${C.bold}o${C.reset} open`,
    `${C.bold}c${C.reset} close`,
    `${C.bold}t${C.reset} terminals`,
    `${C.bold}r${C.reset} refresh`,
    `${C.bold}q${C.reset} quit`,
  ]
  console.log(`  ${keys.join(`  ${C.gray}·${C.reset}  `)}`)
  console.log(divider())
  console.log()
}

// ── Terminal opening ──

function detectEnv(): 'tmux' | 'iterm2' | 'terminal' | 'none' {
  if (process.env.TMUX) return 'tmux'
  if (process.env.TERM_PROGRAM === 'iTerm.app') return 'iterm2'
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return 'terminal'
  return 'none'
}

function openWithTmux(roomId: string, cmd1: string, cmd2: string): void {
  spawnSync('tmux', ['new-window', '-n', roomId, cmd1])
  spawnSync('tmux', ['split-window', '-h', cmd2])
  spawnSync('tmux', ['select-pane', '-L'])
}

function openWithAppleScript(
  app: 'iTerm' | 'Terminal',
  roomId: string,
  assistantName: string,
  cmd1: string,
  cmd2: string,
): void {
  const script = app === 'iTerm' ? `
tell application "iTerm"
  activate
  set t to (create tab with default profile)
  tell current session of t
    set name to "${roomId} (${assistantName})"
    write text "${cmd1}"
  end tell
  set t2 to (create tab with default profile)
  tell current session of t2
    set name to "${roomId} (codex)"
    write text "${cmd2}"
  end tell
end tell` : `
tell application "Terminal"
  activate
  do script "${cmd1}"
  do script "${cmd2}"
end tell`
  spawnSync('osascript', ['-e', script])
}

function openRoom(roomId: string, assistantType: 'claude' | 'codex'): 'auto' | 'manual' {
  const assistantCmd = assistantType === 'codex'
    ? `bridge-codex-peer ${roomId}`
    : `bridge-claude ${roomId}`
  const assistantName = assistantType === 'codex' ? 'codex-peer' : 'claude'
  const codexCmd  = `bridge-codex ${roomId}`
  const env = detectEnv()
  if (env === 'tmux')     { openWithTmux(roomId, assistantCmd, codexCmd); return 'auto' }
  if (env === 'iterm2')   { openWithAppleScript('iTerm',    roomId, assistantName, assistantCmd, codexCmd); return 'auto' }
  if (env === 'terminal') { openWithAppleScript('Terminal', roomId, assistantName, assistantCmd, codexCmd); return 'auto' }
  return 'manual'
}

// ── Interactive prompt ──

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

// ── Main ──

async function main(): Promise<void> {
  process.stdout.write(`\n  ${C.dim}Connecting to bridge...${C.reset} `)
  try {
    await ensureBridge()
    console.log(`${C.bgreen}ready${C.reset}\n`)
  } catch (err) {
    console.error(`\n  ${C.red}✗${C.reset} ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  while (true) {
    const rooms = await getRooms()
    printRooms(rooms)

    const choice = (await prompt(rl, `  ${C.bcyan}›${C.reset} `)).trim().toLowerCase()

    if (choice === 'q' || choice === 'quit') {
      rl.close()
      console.log(`\n  ${C.dim}bye.${C.reset}\n`)
      process.exit(0)
    }

    if (choice === 'r' || choice === 'refresh') continue

    if (choice === 'o' || choice === 'open') {
      const ticketRaw = (await prompt(rl, `  ${C.gray}Room ID (e.g. ENG-1234):${C.reset} `)).trim()
      const ticket = ticketRaw.toUpperCase()
      if (!ticket) { console.log(`  ${C.gray}Cancelled.${C.reset}`); continue }
      const assistantTypeRaw = (await prompt(
        rl,
        `  ${C.gray}Assistant type [claude/codex] (default: claude):${C.reset} `,
      )).trim().toLowerCase()
      const assistantType = assistantTypeRaw === 'codex' ? 'codex' : 'claude'
      if (rooms.find(r => r.id === ticket)) {
        console.log(`  ${C.yellow}⚠${C.reset}  Room ${C.bold}${ticket}${C.reset} already exists.`)
        await Bun.sleep(900)
        continue
      }
      await fetch(`${BRIDGE_URL}/api/rooms/${encodeURIComponent(ticket)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistantType }),
      }).catch(() => {})
      const mode = openRoom(ticket, assistantType)
      if (mode === 'manual') {
        if (assistantType === 'codex') {
          console.log(`\n  ${C.gray}[codex-peer]${C.reset}  bridge-codex-peer ${ticket}`)
        } else {
          console.log(`\n  ${C.gray}[claude]${C.reset}  bridge-claude ${ticket}`)
        }
        console.log(`  ${C.gray}[codex] ${C.reset}  bridge-codex ${ticket}\n`)
        await prompt(rl, `  ${C.gray}Press Enter once both terminals are running...${C.reset} `)
      } else {
        await Bun.sleep(800)
      }
      continue
    }

    if (choice === 't' || choice === 'terminal' || choice === 'terminals') {
      const terminalTargets = getTerminalTargets()
      if (terminalTargets.length === 0) {
        console.log(`  ${C.gray}No terminals to stop.${C.reset}`)
        await Bun.sleep(700)
        continue
      }

      console.log()
      terminalTargets.forEach((target, i) => {
        const parts: string[] = []
        if (target.claudeCount > 0) parts.push(`${C.purple}claude${C.reset} ×${target.claudeCount}`)
        if (target.codexCount > 0) parts.push(`${C.green}codex${C.reset} ×${target.codexCount}`)
        if (target.codexPeerCount > 0) parts.push(`${C.bcyan}codex-peer${C.reset} ×${target.codexPeerCount}`)
        console.log(`  ${C.bold}[${i + 1}]${C.reset}  ${C.bold}${target.roomId}${C.reset}   ${parts.join('   ')}`)
      })

      const pick = (await prompt(
        rl,
        `\n  ${C.gray}Stop terminal # — single or comma-separated (e.g. 1,2,3):${C.reset} `,
      )).trim()

      if (pick) {
        const indices = parseSelection(pick, terminalTargets.length)
        for (const idx of indices) {
          const target = terminalTargets[idx]
          const summary = await shutdownRoomTerminals(target.roomId)
          console.log(summarizeShutdown(target.roomId, summary))
        }
        if (indices.length > 0) await Bun.sleep(700)
      }
      continue
    }

    if (choice === 'c' || choice === 'close') {
      if (rooms.length === 0) { console.log(`  ${C.gray}No rooms to close.${C.reset}`); await Bun.sleep(700); continue }
      console.log()
      const sorted = [...rooms].sort((a, b) => a.id.localeCompare(b.id))
      sorted.forEach((r, i) => {
        const codex  = r.codexConnected  ? `${C.bgreen}◉${C.reset}`  : `${C.gray}◯${C.reset}`
        const assistant = roomAssistantConnected(r) ? `${roomAssistantColor(r)}◉${C.reset}` : `${C.gray}◯${C.reset}`
        console.log(`  ${C.bold}[${i + 1}]${C.reset}  ${C.bold}${r.id}${C.reset}   ${codex} codex  ${assistant} ${roomAssistantLabel(r)}`)
      })
      const pick = (await prompt(rl, `\n  ${C.gray}Close room # — single or comma-separated (e.g. 1,2,3):${C.reset} `)).trim()
      if (pick) {
        const indices = parseSelection(pick, sorted.length)
        for (const idx of indices) {
          const target = sorted[idx].id
          const ok = await closeRoom(target)
          const shutdown = await shutdownRoomTerminals(target)
          console.log(ok
            ? `  ${C.bgreen}✓${C.reset}  ${C.bold}${target}${C.reset} closed.`
            : `  ${C.red}✗${C.reset}  Failed to close ${target}.`)
          console.log(summarizeShutdown(target, shutdown))
        }
        if (indices.length > 0) await Bun.sleep(700)
      }
      continue
    }
  }
}

await main()
