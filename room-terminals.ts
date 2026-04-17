import { readdirSync, readFileSync, unlinkSync } from 'fs'

export type BridgeAgent = 'claude' | 'codex'

export type BridgeSession = {
  agent: BridgeAgent
  pid: number
  pidFile: string
  roomId: string
}

export type TerminalSessions = Map<string, { claude: number[]; codex: number[] }>

type Signal = NodeJS.Signals | 0

type RoomTerminalDeps = {
  readdirSync: typeof readdirSync
  readFileSync: typeof readFileSync
  unlinkSync: typeof unlinkSync
  kill: (pid: number, signal?: Signal) => void
  sleep: (ms: number) => Promise<void>
  tmpDir: string
}

export type ShutdownSummary = {
  roomId: string
  matched: number
  terminated: number[]
  forced: number[]
  cleanedPidFiles: string[]
  failures: Array<{ pid: number; agent: BridgeAgent; stage: 'SIGTERM' | 'SIGKILL'; reason: string }>
}

const defaultDeps: RoomTerminalDeps = {
  readdirSync,
  readFileSync,
  unlinkSync,
  kill: (pid, signal) => process.kill(pid, signal),
  sleep: ms => Bun.sleep(ms),
  tmpDir: '/tmp',
}

function parseSession(
  file: string,
  deps: RoomTerminalDeps,
): BridgeSession | null {
  const match = file.match(/^(claude|codex)-bridge-room-(\d+)$/)
  if (!match) return null

  const [, agent, rawPid] = match
  const pid = Number(rawPid)
  if (!Number.isInteger(pid) || pid <= 0) return null

  try {
    const content = deps.readFileSync(`${deps.tmpDir}/${file}`, 'utf8').trim()
    const roomId = content.split(':')[0]?.trim()
    if (!roomId) return null
    return {
      agent: agent as BridgeAgent,
      pid,
      pidFile: `${deps.tmpDir}/${file}`,
      roomId,
    }
  } catch {
    return null
  }
}

function isAlive(pid: number, deps: RoomTerminalDeps): boolean {
  try {
    deps.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function safeUnlink(pidFile: string, deps: RoomTerminalDeps, cleanedPidFiles: string[]) {
  try {
    deps.unlinkSync(pidFile)
    cleanedPidFiles.push(pidFile)
  } catch {}
}

export function listBridgeSessions(overrides: Partial<RoomTerminalDeps> = {}): BridgeSession[] {
  const deps = { ...defaultDeps, ...overrides }
  const sessions: BridgeSession[] = []

  try {
    for (const file of deps.readdirSync(deps.tmpDir)) {
      const session = parseSession(file, deps)
      if (!session) continue
      if (!isAlive(session.pid, deps)) continue
      sessions.push(session)
    }
  } catch {}

  return sessions
}

export function getTerminalSessions(overrides: Partial<RoomTerminalDeps> = {}): TerminalSessions {
  const sessions: TerminalSessions = new Map()

  for (const session of listBridgeSessions(overrides)) {
    if (!sessions.has(session.roomId)) {
      sessions.set(session.roomId, { claude: [], codex: [] })
    }
    sessions.get(session.roomId)![session.agent].push(session.pid)
  }

  return sessions
}

export async function shutdownRoomTerminals(
  roomId: string,
  overrides: Partial<RoomTerminalDeps> = {},
): Promise<ShutdownSummary> {
  const deps = { ...defaultDeps, ...overrides }
  const matchedSessions = listBridgeSessions(deps).filter(session => session.roomId === roomId)
  const summary: ShutdownSummary = {
    roomId,
    matched: matchedSessions.length,
    terminated: [],
    forced: [],
    cleanedPidFiles: [],
    failures: [],
  }

  if (matchedSessions.length === 0) return summary

  for (const session of matchedSessions) {
    try {
      deps.kill(session.pid, 'SIGTERM')
    } catch (error) {
      summary.failures.push({
        pid: session.pid,
        agent: session.agent,
        stage: 'SIGTERM',
        reason: error instanceof Error ? error.message : String(error),
      })
    }
  }

  await deps.sleep(250)

  for (const session of matchedSessions) {
    if (!isAlive(session.pid, deps)) {
      summary.terminated.push(session.pid)
      safeUnlink(session.pidFile, deps, summary.cleanedPidFiles)
      continue
    }

    try {
      deps.kill(session.pid, 'SIGKILL')
      summary.forced.push(session.pid)
    } catch (error) {
      summary.failures.push({
        pid: session.pid,
        agent: session.agent,
        stage: 'SIGKILL',
        reason: error instanceof Error ? error.message : String(error),
      })
      continue
    }

    await deps.sleep(50)

    if (!isAlive(session.pid, deps)) {
      safeUnlink(session.pidFile, deps, summary.cleanedPidFiles)
      continue
    }

    summary.failures.push({
      pid: session.pid,
      agent: session.agent,
      stage: 'SIGKILL',
      reason: 'process still alive after SIGKILL',
    })
  }

  return summary
}
