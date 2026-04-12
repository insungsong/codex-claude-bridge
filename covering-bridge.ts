#!/usr/bin/env bun
/**
 * covering-bridge — Room manager CLI for the Codex-Claude multi-room bridge.
 *
 * Usage:
 *   bun covering-bridge.ts
 *
 * Shows active rooms, lets you open new rooms (by ticket number) and close them.
 * Rooms stay open until explicitly closed — no auto-expiry.
 *
 * Terminal opening strategy (in priority order):
 *   1. tmux  — new window with vertical split (claude left, codex right)
 *   2. iTerm2 — new tab via AppleScript
 *   3. Terminal.app — new tab via AppleScript
 *   4. Fallback — print commands for manual execution
 */

import { createInterface } from 'readline'
import { spawnSync } from 'child_process'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const BRIDGE_DIR = new URL('.', import.meta.url).pathname

type Room = {
  id: string
  createdAt: number
  claudeConnected: boolean
  codexConnected: boolean
  lastActivity: number
}

// ── Bridge server management ──

async function isBridgeRunning(): Promise<boolean> {
  try {
    // Check /api/rooms (multi-room endpoint) — distinguishes new bridge-server from legacy server.ts
    const res = await fetch(`${BRIDGE_URL}/api/rooms`, { signal: AbortSignal.timeout(2000) })
    return res.ok && Array.isArray(await res.json())
  } catch {
    return false
  }
}

async function startBridgeServer(): Promise<void> {
  console.log('  Starting bridge server...')
  const serverPath = `${BRIDGE_DIR}bridge-server.ts`
  const proc = Bun.spawn(['bun', serverPath], {
    stdout: 'ignore',
    stderr: 'ignore',
    stdin: 'ignore',
  })
  // Detach so it outlives this process
  proc.unref()
  // Wait for it to become ready
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
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`
  return `${Math.floor(secs / 3600)}h ago`
}

function connStatus(claude: boolean, codex: boolean): string {
  const c = claude ? '\x1b[32mclaude \u2713\x1b[0m' : '\x1b[90mclaude \u2717\x1b[0m'
  const x = codex  ? '\x1b[32mcodex \u2713\x1b[0m'  : '\x1b[90mcodex \u2717\x1b[0m'
  return `${c}  ${x}`
}

function printRooms(rooms: Room[]): void {
  console.clear()
  console.log('\x1b[1m\x1b[36m  Codex\u2013Claude Bridge\x1b[0m  \x1b[90mv0.3 multi-room\x1b[0m')
  console.log(`  ${BRIDGE_URL}\n`)

  if (rooms.length === 0) {
    console.log('  \x1b[90m(no active rooms)\x1b[0m\n')
  } else {
    for (const r of rooms) {
      const age = formatAge(r.lastActivity)
      console.log(`  \x1b[1m${r.id.padEnd(14)}\x1b[0m  ${connStatus(r.claudeConnected, r.codexConnected)}   \x1b[90m${age}\x1b[0m`)
    }
    console.log()
  }

  console.log('  \x1b[90m[o] open new room   [c] close room   [r] refresh   [q] quit\x1b[0m\n')
}

// ── Terminal opening ──

function detectEnv(): 'tmux' | 'iterm2' | 'terminal' | 'none' {
  if (process.env.TMUX) return 'tmux'
  if (process.env.TERM_PROGRAM === 'iTerm.app') return 'iterm2'
  // Check if Terminal.app is running via $TERM_PROGRAM
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return 'terminal'
  return 'none'
}

function openWithTmux(roomId: string, cmd1: string, cmd2: string): void {
  // New window named after the room, split into left (claude) and right (codex)
  spawnSync('tmux', ['new-window', '-n', roomId, cmd1])
  spawnSync('tmux', ['split-window', '-h', cmd2])
  spawnSync('tmux', ['select-pane', '-L']) // focus left (claude)
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
  const codexCmd = `bridge-codex ${roomId}`
  const env = detectEnv()

  console.log(`\n  Opening room \x1b[1m${roomId}\x1b[0m...`)

  if (env === 'tmux') {
    openWithTmux(roomId, claudeCmd, codexCmd)
    console.log('  \x1b[32m\u2713\x1b[0m tmux window opened (claude left, codex right)\n')
    return 'auto'
  }

  if (env === 'iterm2') {
    openWithAppleScript('iTerm', roomId, claudeCmd, codexCmd)
    console.log('  \x1b[32m\u2713\x1b[0m iTerm2 tabs opened\n')
    return 'auto'
  }

  if (env === 'terminal') {
    openWithAppleScript('Terminal', roomId, claudeCmd, codexCmd)
    console.log('  \x1b[32m\u2713\x1b[0m Terminal.app windows opened\n')
    return 'auto'
  }

  // Fallback: print commands for manual execution
  console.log('\n  Run these in two separate terminals:\n')
  console.log(`  \x1b[33m[Claude]\x1b[0m  ${claudeCmd}`)
  console.log(`  \x1b[32m[Codex] \x1b[0m  ${codexCmd}\n`)
  return 'manual'
}

// ── Interactive prompt ──

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

async function main(): Promise<void> {
  try {
    process.stdout.write('  Connecting to bridge... ')
    await ensureBridge()
    console.log('\x1b[32mready\x1b[0m\n')
  } catch (err) {
    console.error(`\n  \x1b[31mError:\x1b[0m ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const rooms = await getRooms()
    printRooms(rooms)

    const choice = (await prompt(rl, '  > ')).trim().toLowerCase()

    if (choice === 'q' || choice === 'quit') {
      rl.close()
      console.log('  bye.')
      process.exit(0)
    }

    if (choice === 'r' || choice === 'refresh') {
      continue
    }

    if (choice === 'o' || choice === 'open') {
      const ticketRaw = (await prompt(rl, '  Ticket number (e.g. ENG-1234): ')).trim()
      const ticket = ticketRaw.toUpperCase()
      if (!ticket) { console.log('  Cancelled.'); continue }
      if (rooms.find(r => r.id === ticket)) {
        console.log(`  \x1b[33mRoom ${ticket} already exists.\x1b[0m`)
        await Bun.sleep(1000)
        continue
      }
      // Pre-register room in bridge-server so it appears in the list immediately
      await fetch(`${BRIDGE_URL}/api/rooms/${encodeURIComponent(ticket)}`, { method: 'POST' }).catch(() => {})
      const mode = openRoom(ticket)
      if (mode === 'manual') {
        // Fallback: keep commands visible until user presses Enter
        await prompt(rl, '  Press Enter when you have started both terminals... ')
      } else {
        await Bun.sleep(800)
      }
      continue
    }

    if (choice === 'c' || choice === 'close') {
      if (rooms.length === 0) { console.log('  No rooms to close.'); await Bun.sleep(800); continue }
      console.log('\n  Active rooms:')
      rooms.forEach((r, i) => console.log(`    [${i + 1}] ${r.id}`))
      const pick = (await prompt(rl, '  Close room number (or Enter to cancel): ')).trim()
      if (!pick) { console.log('  Cancelled.'); continue }
      const idx = parseInt(pick, 10) - 1
      if (isNaN(idx) || idx < 0 || idx >= rooms.length) {
        console.log('  Invalid selection.')
        await Bun.sleep(800)
        continue
      }
      const target = rooms[idx].id
      const ok = await closeRoom(target)
      console.log(ok ? `  \x1b[32m\u2713\x1b[0m Room ${target} closed.` : `  \x1b[31mFailed to close ${target}.\x1b[0m`)
      await Bun.sleep(800)
      continue
    }

    // Unknown input — refresh
  }
}

await main()
