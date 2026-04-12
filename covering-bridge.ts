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
  bcyan:   '\x1b[96m',
  green:   '\x1b[32m',
  bgreen:  '\x1b[92m',
  purple:  '\x1b[35m',
  bpurple: '\x1b[95m',
  yellow:  '\x1b[33m',
  gray:    '\x1b[90m',
  white:   '\x1b[97m',
  red:     '\x1b[31m',
  cyan:    '\x1b[36m',
}

function vis(s: string) { return s.replace(/\x1b\[[0-9;]*m/g, '') }
function rpad(s: string, n: number) {
  const diff = n - vis(s).length
  return diff > 0 ? s + ' '.repeat(diff) : s
}

const BOX = 54
function boxTop()    { return `  ${C.gray}╭${'─'.repeat(BOX)}╮${C.reset}` }
function boxBottom() { return `  ${C.gray}╰${'─'.repeat(BOX)}╯${C.reset}` }
function boxRow(content: string) {
  const pad = BOX - vis(content).length
  return `  ${C.gray}│${C.reset}${content}${' '.repeat(Math.max(0, pad))}${C.gray}│${C.reset}`
}
function divider() { return `  ${C.gray}${'─'.repeat(BOX)}${C.reset}` }

// ── Rabbit animation frames ──
// 6 frames: sit → crouch → jump low → jump high → fall → land

const RABBIT_FRAMES: string[][] = [
  // 0: sitting, relaxed
  [
    `  ${C.bgreen} (\\ /)${C.reset}`,
    `  ${C.bgreen}( •ω• )${C.reset}`,
    `  ${C.bgreen}づ${C.yellow}♡${C.reset}${C.bgreen}⊂ )${C.reset}`,
    `  ${C.gray}  |  |${C.reset}`,
    `  ${C.gray} (_(_)${C.reset}`,
    `  ${C.yellow}   ♪${C.reset}`,
  ],
  // 1: crouch (preparing to jump)
  [
    `  ${C.bgreen} (\\ /)${C.reset}`,
    `  ${C.bgreen}( •ω• )${C.reset}`,
    `  ${C.bgreen}づ${C.yellow}♡${C.reset}${C.bgreen}⊂ )${C.reset}`,
    `  ${C.gray}  ) )${C.reset}`,
    `  ${C.gray} (__))${C.reset}`,
    ``,
  ],
  // 2: jumping (low)
  [
    `  ${C.bgreen} /\\ /\\${C.reset}`,
    `  ${C.bgreen}( •ω• )${C.reset}`,
    `  ${C.bgreen}づ${C.yellow}♡${C.reset}${C.bgreen}⊂ )${C.reset}`,
    `  ${C.gray}  ~ ~${C.reset}`,
    ``,
    `  ${C.yellow}  ♪${C.reset}`,
  ],
  // 3: peak of jump
  [
    `  ${C.bgreen} /\\ /\\${C.reset}`,
    `  ${C.bgreen}(*ω*↑)${C.reset}`,
    `  ${C.bgreen} づ${C.yellow}♡${C.reset}${C.bgreen}⊂)${C.reset}`,
    ``,
    `  ${C.yellow}  ✦${C.reset}`,
    `  ${C.yellow} ♪ ♪${C.reset}`,
  ],
  // 4: falling
  [
    `  ${C.bgreen} /\\ /\\${C.reset}`,
    `  ${C.bgreen}( •ω• )${C.reset}`,
    `  ${C.bgreen}づ${C.yellow}♡${C.reset}${C.bgreen}⊂ )${C.reset}`,
    `  ${C.gray}  \\ \\${C.reset}`,
    ``,
    `  ${C.yellow}  ♪${C.reset}`,
  ],
  // 5: landing (happy)
  [
    `  ${C.bgreen} (\\ /)${C.reset}`,
    `  ${C.bgreen}( >ω<)${C.reset}`,
    `  ${C.bgreen}づ${C.yellow}♡${C.reset}${C.bgreen}⊂ )${C.reset}`,
    `  ${C.gray}  |  |${C.reset}`,
    `  ${C.gray} (_(_)${C.reset}`,
    `  ${C.yellow} ～♪${C.reset}`,
  ],
]

// Frame timing: longer pause on sit/land, quick on jump
const FRAME_DURATIONS = [500, 150, 200, 300, 200, 400]  // ms per frame

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

/** Print two line arrays side by side. */
function sideBySide(left: string[], right: string[], leftWidth: number): void {
  const rows = Math.max(left.length, right.length)
  for (let i = 0; i < rows; i++) {
    const l = left[i]  ?? ''
    const r = right[i] ?? ''
    process.stdout.write(l + ' '.repeat(Math.max(0, leftWidth - vis(l).length)) + r + '\n')
  }
}

function renderScreen(rooms: Room[], frame: number): void {
  console.clear()

  // ── Header + Rabbit (side by side) ──
  const leftWidth = BOX + 4
  const headerLines = [
    boxTop(),
    boxRow(`  ${C.bold}${C.bcyan}◈  Codex · Claude Bridge${C.reset}  ${C.dim}룸 관리 대시보드${C.reset}  ${C.gray}${VERSION}${C.reset}`),
    boxRow(`     ${C.dim}multi-room agent bridge${C.reset}`),
    boxBottom(),
  ]
  console.log()
  sideBySide(headerLines, RABBIT_FRAMES[frame], leftWidth)
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
    for (const r of rooms) {
      const codex  = agentDot(r.codexConnected,  C.bgreen)
      const claude = agentDot(r.claudeConnected, C.bpurple)
      const codexL  = r.codexConnected  ? `${C.green}codex${C.reset}`  : `${C.gray}codex${C.reset}`
      const claudeL = r.claudeConnected ? `${C.purple}claude${C.reset}` : `${C.gray}claude${C.reset}`
      const id  = rpad(`${C.bold}${r.id}${C.reset}`, 14)
      const age = formatAge(r.lastActivity)
      console.log(`  ${id}  ${codex} ${codexL}   ${claude} ${claudeL}   ${age}`)
    }
  }
  console.log()

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
  process.stdout.write(`  ${C.bcyan}›${C.reset} `)
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
  const script = app === 'iTerm' ? `
tell application "iTerm"
  activate
  set t to (create tab with default profile)
  tell current session of t
    set name to "${roomId} (claude)"
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

function openRoom(roomId: string): 'auto' | 'manual' {
  const claudeCmd = `bridge-claude ${roomId}`
  const codexCmd  = `bridge-codex ${roomId}`
  const env = detectEnv()
  if (env === 'tmux')     { openWithTmux(roomId, claudeCmd, codexCmd); return 'auto' }
  if (env === 'iterm2')   { openWithAppleScript('iTerm',    roomId, claudeCmd, codexCmd); return 'auto' }
  if (env === 'terminal') { openWithAppleScript('Terminal', roomId, claudeCmd, codexCmd); return 'auto' }
  return 'manual'
}

// ── Interactive prompt (temporarily suspends animation) ──

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

  let rooms = await getRooms()
  let frame = 0
  let animating = true

  // ── Room data fetch — every 1s (age display + connection status) ──
  const pollRooms = setInterval(async () => {
    if (animating) rooms = await getRooms()
  }, 1000)

  // ── Animation loop — per-frame timing for rabbit ──
  function tick() {
    if (!animating) return
    renderScreen(rooms, frame)
    frame = (frame + 1) % RABBIT_FRAMES.length
    setTimeout(tick, FRAME_DURATIONS[frame])
  }
  tick()

  // ── Raw mode key handling ──
  process.stdin.setRawMode(true)
  process.stdin.resume()
  process.stdin.setEncoding('utf8')

  /** Pause animation and drop to readline for multi-char input. */
  async function suspendAndPrompt(question: string): Promise<string> {
    animating = false
    process.stdin.setRawMode(false)
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    process.stdout.write('\n')
    const answer = await prompt(rl, `  ${question}`)
    rl.close()
    process.stdin.setRawMode(true)
    animating = true
    void tick()
    return answer
  }

  process.stdin.on('data', async (key: string) => {
    if (!animating) return
    const k = key.toLowerCase()

    // Ctrl+C or q → quit
    if (k === '\u0003' || k === 'q') {
      animating = false
      clearInterval(pollRooms)
      process.stdin.setRawMode(false)
      console.clear()
      console.log(`\n  ${C.dim}bye. 🐇${C.reset}\n`)
      process.exit(0)
    }

    if (k === 'r') {
      rooms = await getRooms()
      renderScreen(rooms, frame)
      return
    }

    if (k === 'o') {
      const ticketRaw = await suspendAndPrompt(`${C.gray}Room ID (e.g. ENG-1234):${C.reset} `)
      const ticket = ticketRaw.trim().toUpperCase()
      if (!ticket) return
      if (rooms.find(r => r.id === ticket)) {
        process.stdout.write(`  ${C.yellow}⚠${C.reset}  Room ${C.bold}${ticket}${C.reset} already exists.\n`)
        await Bun.sleep(900)
        return
      }
      await fetch(`${BRIDGE_URL}/api/rooms/${encodeURIComponent(ticket)}`, { method: 'POST' }).catch(() => {})
      const mode = openRoom(ticket)
      if (mode === 'manual') {
        process.stdout.write(`\n  ${C.gray}[claude]${C.reset}  bridge-claude ${ticket}\n`)
        process.stdout.write(`  ${C.gray}[codex] ${C.reset}  bridge-codex ${ticket}\n`)
        await suspendAndPrompt(`${C.gray}Press Enter once both terminals are running...${C.reset}`)
      } else {
        await Bun.sleep(800)
      }
      return
    }

    if (k === 'c') {
      if (rooms.length === 0) return
      animating = false
      process.stdin.setRawMode(false)
      console.clear()
      console.log()
      rooms.forEach((r, i) => {
        const codex  = r.codexConnected  ? `${C.bgreen}◉${C.reset}`  : `${C.gray}◯${C.reset}`
        const claude = r.claudeConnected ? `${C.bpurple}◉${C.reset}` : `${C.gray}◯${C.reset}`
        console.log(`  ${C.bold}[${i + 1}]${C.reset}  ${C.bold}${r.id}${C.reset}   ${codex} codex  ${claude} claude`)
      })
      const rl = createInterface({ input: process.stdin, output: process.stdout })
      const pick = (await prompt(rl, `\n  ${C.gray}Close room # (Enter to cancel):${C.reset} `)).trim()
      rl.close()
      if (pick) {
        const idx = parseInt(pick, 10) - 1
        if (!isNaN(idx) && idx >= 0 && idx < rooms.length) {
          const target = rooms[idx].id
          const ok = await closeRoom(target)
          process.stdout.write(ok
            ? `  ${C.bgreen}✓${C.reset}  ${C.bold}${target}${C.reset} closed.\n`
            : `  ${C.red}✗${C.reset}  Failed.\n`)
          await Bun.sleep(700)
        }
      }
      process.stdin.setRawMode(true)
      animating = true
      void tick()
    }
  })
}

await main()
