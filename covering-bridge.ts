#!/usr/bin/env bun
/**
 * covering-bridge — Room manager CLI for the Codex-Claude multi-room bridge.
 */

import { createInterface } from 'readline'
import { spawnSync } from 'child_process'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const BRIDGE_DIR = new URL('.', import.meta.url).pathname
const VERSION = 'v0.4'

type Room = {
  id: string
  createdAt: number
  claudeConnected: boolean
  codexConnected: boolean
  lastActivity: number
}

// ── ANSI helpers ──

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  cyan:    '\x1b[36m',
  bcyan:   '\x1b[96m',    // bright cyan  — header
  green:   '\x1b[32m',    // codex live
  bgreen:  '\x1b[92m',    // codex live bright
  purple:  '\x1b[35m',    // claude live
  bpurple: '\x1b[95m',    // claude live bright
  yellow:  '\x1b[33m',
  gray:    '\x1b[90m',
  white:   '\x1b[97m',
  red:     '\x1b[31m',
}

/** Strip ANSI codes to measure visible length. */
function vis(s: string) { return s.replace(/\x1b\[[0-9;]*m/g, '') }

/** Right-pad to visible width n. */
function rpad(s: string, n: number) {
  const diff = n - vis(s).length
  return diff > 0 ? s + ' '.repeat(diff) : s
}

// ── Box drawing ──

const BOX = 54  // inner width (between │)

function boxTop()    { return `╭${'─'.repeat(BOX)}╮` }
function boxBottom() { return `╰${'─'.repeat(BOX)}╯` }
function boxRow(content: string) {
  const padding = BOX - vis(content).length
  return `│${content}${' '.repeat(Math.max(0, padding))}│`
}
function divider(char = '─') { return `  ${char.repeat(BOX - 2)}` }

// ── Bridge server management ──

async function isBridgeRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/rooms`, { signal: AbortSignal.timeout(2000) })
    return res.ok && Array.isArray(await res.json())
  } catch {
    return false
  }
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
  } catch {
    return []
  }
}

async function closeRoom(roomId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BRIDGE_URL}/api/rooms/${encodeURIComponent(roomId)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(3000) },
    )
    return res.status === 204
  } catch {
    return false
  }
}

// ── Display ──

function formatAge(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000)
  if (secs < 5)    return `${C.bgreen}just now${C.reset}`
  if (secs < 60)   return `${C.gray}${secs}s ago${C.reset}`
  if (secs < 3600) return `${C.gray}${Math.floor(secs / 60)}m ago${C.reset}`
  return `${C.gray}${Math.floor(secs / 3600)}h ago${C.reset}`
}

function agentDot(connected: boolean, color: string): string {
  return connected
    ? `${color}●${C.reset}`
    : `${C.gray}○${C.reset}`
}

function printRooms(rooms: Room[]): void {
  console.clear()

  // ── Header box ──
  console.log(boxTop())
  console.log(boxRow(''))
  console.log(boxRow(`  ${C.bold}${C.bcyan}◈  Codex · Claude Bridge${C.reset}  ${C.gray}${VERSION}${C.reset}`))
  console.log(boxRow(`     ${C.dim}multi-room bridge${C.reset}`))
  console.log(boxRow(''))
  console.log(boxBottom())
  console.log()

  // ── Status line ──
  const roomCount = rooms.length === 0
    ? `${C.gray}no active rooms${C.reset}`
    : `${C.bold}${rooms.length}${C.reset} ${rooms.length === 1 ? 'room' : 'rooms'} active`
  console.log(`  ${roomCount}  ${C.gray}·${C.reset}  ${C.dim}${BRIDGE_URL}${C.reset}`)
  console.log()

  // ── Room list ──
  if (rooms.length === 0) {
    console.log(`  ${C.gray}No rooms yet. Press ${C.reset}${C.bold}o${C.reset}${C.gray} to open one.${C.reset}`)
    console.log()
  } else {
    for (const r of rooms) {
      const claude = agentDot(r.claudeConnected, C.bpurple)
      const codex  = agentDot(r.codexConnected,  C.bgreen)

      const claudeLabel = r.claudeConnected
        ? `${C.purple}claude${C.reset}`
        : `${C.gray}claude${C.reset}`
      const codexLabel = r.codexConnected
        ? `${C.green}codex${C.reset}`
        : `${C.gray}codex${C.reset}`

      const id  = rpad(`${C.bold}${r.id}${C.reset}`, 22)
      const age = formatAge(r.lastActivity)

      console.log(`  ${id}  ${claude} ${claudeLabel}   ${codex} ${codexLabel}   ${age}`)
    }
    console.log()
  }

  // ── Footer ──
  console.log(divider())
  const keys = [
    `${C.bold}o${C.reset} open`,
    `${C.bold}c${C.reset} close`,
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

function openWithAppleScript(app: 'iTerm' | 'Terminal', roomId: string, cmd1: string, cmd2: string): void {
  let script: string
  if (app === 'iTerm') {
    script = `
tell application "iTerm"
  activate
  set newTab to (create tab with default profile)
  tell current session of newTab
    set name to "${roomId} (claude)"
    write text "${cmd1}"
  end tell
  set newTab2 to (create tab with default profile)
  tell current session of newTab2
    set name to "${roomId} (codex)"
    write text "${cmd2}"
  end tell
end tell`
  } else {
    script = `
tell application "Terminal"
  activate
  do script "${cmd1}"
  do script "${cmd2}"
end tell`
  }
  spawnSync('osascript', ['-e', script])
}

function openRoom(roomId: string): 'auto' | 'manual' {
  const claudeCmd = `bridge-claude ${roomId}`
  const codexCmd  = `bridge-codex ${roomId}`
  const env = detectEnv()

  console.log(`\n  ${C.dim}Opening${C.reset} ${C.bold}${roomId}${C.reset} ...`)

  if (env === 'tmux') {
    openWithTmux(roomId, claudeCmd, codexCmd)
    console.log(`  ${C.bgreen}✓${C.reset} tmux window opened ${C.gray}(claude left · codex right)${C.reset}\n`)
    return 'auto'
  }
  if (env === 'iterm2') {
    openWithAppleScript('iTerm', roomId, claudeCmd, codexCmd)
    console.log(`  ${C.bgreen}✓${C.reset} iTerm2 tabs opened\n`)
    return 'auto'
  }
  if (env === 'terminal') {
    openWithAppleScript('Terminal', roomId, claudeCmd, codexCmd)
    console.log(`  ${C.bgreen}✓${C.reset} Terminal.app windows opened\n`)
    return 'auto'
  }

  // Fallback
  console.log(`\n  ${C.gray}Run these in two separate terminals:${C.reset}\n`)
  console.log(`  ${C.purple}[claude]${C.reset}  ${claudeCmd}`)
  console.log(`  ${C.green}[codex] ${C.reset}  ${codexCmd}\n`)
  return 'manual'
}

// ── Interactive prompt ──

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

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

  // eslint-disable-next-line no-constant-condition
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
      if (rooms.find(r => r.id === ticket)) {
        console.log(`  ${C.yellow}⚠${C.reset}  Room ${C.bold}${ticket}${C.reset} already exists.`)
        await Bun.sleep(1000)
        continue
      }
      await fetch(`${BRIDGE_URL}/api/rooms/${encodeURIComponent(ticket)}`, { method: 'POST' }).catch(() => {})
      const mode = openRoom(ticket)
      if (mode === 'manual') {
        await prompt(rl, `  ${C.gray}Press Enter once both terminals are running...${C.reset} `)
      } else {
        await Bun.sleep(800)
      }
      continue
    }

    if (choice === 'c' || choice === 'close') {
      if (rooms.length === 0) {
        console.log(`  ${C.gray}No rooms to close.${C.reset}`)
        await Bun.sleep(800)
        continue
      }
      console.log()
      rooms.forEach((r, i) => {
        const claude = agentDot(r.claudeConnected, C.bpurple)
        const codex  = agentDot(r.codexConnected,  C.bgreen)
        console.log(`  ${C.bold}[${i + 1}]${C.reset}  ${r.id}   ${claude} ${codex}`)
      })
      console.log()
      const pick = (await prompt(rl, `  ${C.gray}Close room # (Enter to cancel):${C.reset} `)).trim()
      if (!pick) { console.log(`  ${C.gray}Cancelled.${C.reset}`); continue }
      const idx = parseInt(pick, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= rooms.length) {
        console.log(`  ${C.red}✗${C.reset}  Invalid selection.`)
        await Bun.sleep(800)
        continue
      }
      const target = rooms[idx].id
      const ok = await closeRoom(target)
      console.log(ok
        ? `  ${C.bgreen}✓${C.reset}  ${C.bold}${target}${C.reset} closed.`
        : `  ${C.red}✗${C.reset}  Failed to close ${target}.`)
      await Bun.sleep(800)
      continue
    }

    // Unknown — refresh silently
  }
}

await main()
