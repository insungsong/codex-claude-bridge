// bridge-server.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import { spawn, type ChildProcess } from 'child_process'
import { unlinkSync, existsSync, writeFileSync, readFileSync } from 'fs'

let nextTestPort = 24567
const processOutput = new WeakMap<ChildProcess, string[]>()

function getTestPort() {
  return nextTestPort++
}

function bridgeServerEnv(
  port: number,
  statePath: string,
  extra: Record<string, string | undefined> = {},
) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    TMPDIR: process.env.TMPDIR ?? '/tmp',
    LANG: process.env.LANG ?? 'C',
    CODEX_BRIDGE_PORT: String(port),
    CODEX_BRIDGE_STATE_FILE: statePath,
    ...extra,
  }
}

function spawnServerWithState(
  statePath: string,
  port: number,
  extraEnv: Record<string, string | undefined> = {},
) {
  const child = spawn('bun', ['bridge-server.ts'], {
    cwd: process.cwd(),
    env: bridgeServerEnv(port, statePath, extraEnv),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const output: string[] = []
  processOutput.set(child, output)
  child.stdout?.on('data', chunk => output.push(String(chunk).trim()))
  child.stderr?.on('data', chunk => output.push(String(chunk).trim()))
  child.on('error', error => output.push(`spawn error: ${error.message}`))
  child.on('exit', (code, signal) => output.push(`exit: code=${code ?? 'null'} signal=${signal ?? 'null'}`))
  return child
}

function waitForExit(proc: ChildProcess | ReturnType<typeof spawnServerWithState>) {
  if (proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(proc.exitCode)
  return new Promise<number | null>(resolve => proc.once('exit', code => resolve(code)))
}

let server: ReturnType<typeof spawnServerWithState> | null = null
let PORT = 0
let BASE = ''

async function waitForHealth(base: string, timeoutMs = 3000, proc?: ChildProcess): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(200) })
      if (res.ok) return
    } catch {}
    await Bun.sleep(50)
  }
  const output = proc ? processOutput.get(proc)?.filter(Boolean).join('\n') : ''
  throw new Error(`bridge-server did not become ready${output ? `\n${output}` : ''}`)
}

beforeAll(async () => {
  PORT = getTestPort()
  BASE = `http://127.0.0.1:${PORT}`
  server = spawnServerWithState(`/tmp/codex-bridge-state-test-${PORT}.json`, PORT)
  try {
    await Bun.sleep(100)
    await waitForHealth(BASE, 3000, server)
  } catch (e) {
    server.kill()
    throw e
  }
})

afterAll(async () => {
  server?.kill()
  if (server) await waitForExit(server)
  try { unlinkSync(`/tmp/codex-bridge-state-test-${PORT}.json`) } catch {}
})

describe('session token', () => {
  test('POST /api/rooms/:roomId returns sessionToken (32 hex chars)', async () => {
    const res = await fetch(`${BASE}/api/rooms/ENG-TEST-1`, { method: 'POST' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.sessionToken).toMatch(/^[a-f0-9]{32}$/)
  })

  test('POST /from-codex without token returns 401', async () => {
    await fetch(`${BASE}/api/rooms/ENG-TEST-2`, { method: 'POST' })
    const res = await fetch(`${BASE}/api/rooms/ENG-TEST-2/from-codex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(401)
  })

  test('POST /from-codex with correct token succeeds', async () => {
    const create = await fetch(`${BASE}/api/rooms/ENG-TEST-3`, { method: 'POST' })
    const { sessionToken } = await create.json() as { sessionToken: string }
    const res = await fetch(`${BASE}/api/rooms/ENG-TEST-3/from-codex`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bridge-token': sessionToken,
      },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect([200, 201]).toContain(res.status)
  })

  test('POST /from-codex with wrong token returns 401', async () => {
    await fetch(`${BASE}/api/rooms/ENG-TEST-4`, { method: 'POST' })
    const res = await fetch(`${BASE}/api/rooms/ENG-TEST-4/from-codex`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-bridge-token': 'deadbeef'.repeat(4),
      },
      body: JSON.stringify({ message: 'hi' }),
    })
    expect(res.status).toBe(401)
  })

  test('token from room A is rejected on room B endpoint', async () => {
    const a = await fetch(`${BASE}/api/rooms/ROOM-A`, { method: 'POST' })
    const { sessionToken: tokenA } = await a.json() as { sessionToken: string }
    await fetch(`${BASE}/api/rooms/ROOM-B`, { method: 'POST' })

    const res = await fetch(`${BASE}/api/rooms/ROOM-B/from-codex`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': tokenA },
      body: JSON.stringify({ message: 'intrude' }),
    })
    expect(res.status).toBe(401)
  })

  test('heartbeat endpoints require token', async () => {
    await fetch(`${BASE}/api/rooms/ROOM-HB`, { method: 'POST' })
    const res = await fetch(`${BASE}/api/rooms/ROOM-HB/codex/heartbeat`, { method: 'POST' })
    expect(res.status).toBe(401)
  })

  test('room recreation rotates token — old token rejected', async () => {
    const c1 = await fetch(`${BASE}/api/rooms/ROOM-ROT`, { method: 'POST' })
    const { sessionToken: oldToken } = await c1.json() as { sessionToken: string }

    await fetch(`${BASE}/api/rooms/ROOM-ROT`, { method: 'DELETE' })
    await Bun.sleep(10_100)  // tombstone expires at 10s
    await fetch(`${BASE}/api/rooms/ROOM-ROT`, { method: 'POST' })

    const res = await fetch(`${BASE}/api/rooms/ROOM-ROT/codex/heartbeat`, {
      method: 'POST',
      headers: { 'x-bridge-token': oldToken },
    })
    expect(res.status).toBe(401)
  }, 15000)

  test('/api/health and /api/rooms remain open (no token)', async () => {
    const h = await fetch(`${BASE}/api/health`)
    expect(h.status).toBe(200)
    const r = await fetch(`${BASE}/api/rooms`)
    expect(r.status).toBe(200)
  })
})

describe('state persistence', () => {
  test('token persists across server restart', async () => {
    const statePath = `/tmp/codex-bridge-state-persist-test-${Date.now()}.json`
    const port = getTestPort()
    const base = `http://127.0.0.1:${port}`

    const s1 = spawnServerWithState(statePath, port)
    await waitForHealth(base)
    const create = await fetch(`${base}/api/rooms/PERSIST-A`, { method: 'POST' })
    const { sessionToken } = await create.json() as { sessionToken: string }

    // Trigger the debounced persist — wait > 500ms
    await Bun.sleep(700)

    s1.kill()
    await waitForExit(s1)

    // Boot a fresh server pointing at the same state file
    const s2 = spawnServerWithState(statePath, port)
    try {
      await waitForHealth(base)
      const heartbeat = await fetch(`${base}/api/rooms/PERSIST-A/codex/heartbeat`, {
        method: 'POST',
        headers: { 'x-bridge-token': sessionToken },
      })
      expect(heartbeat.status).toBe(204)
    } finally {
      s2.kill()
      await waitForExit(s2)
      try { unlinkSync(statePath) } catch {}
    }
  }, 15000)

  test('stale rooms (>1h lastActivity) are skipped on load', async () => {
    const statePath = `/tmp/codex-bridge-state-stale-test-${Date.now()}.json`
    const port = getTestPort()
    const base = `http://127.0.0.1:${port}`

    // Hand-write a state file with lastActivity = 2 hours ago
    const ancientState = {
      version: 1,
      savedAt: Date.now(),
      rooms: [{
        id: 'ANCIENT',
        createdAt: Date.now() - 7200_000,
        sessionToken: '0'.repeat(32),
        lastActivity: Date.now() - 7200_000,
        pendingForCodex: [],
        pendingReplies: [],
      }],
    }
    writeFileSync(statePath, JSON.stringify(ancientState), 'utf8')

    const s = spawnServerWithState(statePath, port)
    try {
      await waitForHealth(base)
      const list = await fetch(`${base}/api/rooms`)
      const rooms = await list.json() as { id: string }[]
      expect(rooms.find(r => r.id === 'ANCIENT')).toBeUndefined()
    } finally {
      s.kill()
      await waitForExit(s)
      try { unlinkSync(statePath) } catch {}
    }
  }, 10000)

  test('corrupted state file is quarantined, server starts clean', async () => {
    const statePath = `/tmp/codex-bridge-state-corrupt-test-${Date.now()}.json`
    const port = getTestPort()
    const base = `http://127.0.0.1:${port}`

    writeFileSync(statePath, '{ this is not json', 'utf8')

    const s = spawnServerWithState(statePath, port)
    try {
      await waitForHealth(base)
      // Server should start despite corrupt file
      const health = await fetch(`${base}/api/health`)
      expect(health.status).toBe(200)
      // Original file should have been renamed to `.corrupted-<ts>`
      expect(existsSync(statePath)).toBe(false)
    } finally {
      s.kill()
      await waitForExit(s)
      // Cleanup any .corrupted-* files (best-effort)
    }
  }, 10000)

  test('pendingForCodex queue persists and is drained after restart', async () => {
    const statePath = `/tmp/codex-bridge-state-queue-test-${Date.now()}.json`
    const port = getTestPort()
    const base = `http://127.0.0.1:${port}`

    const s1 = spawnServerWithState(statePath, port)
    await waitForHealth(base)
    const create = await fetch(`${base}/api/rooms/QUEUE`, { method: 'POST' })
    const { sessionToken } = await create.json() as { sessionToken: string }

    // Claude-side proactive message → into pendingForCodex
    await fetch(`${base}/api/rooms/QUEUE/from-claude`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-bridge-token': sessionToken },
      body: JSON.stringify({ text: 'hello from claude', proactive: true }),
    })

    await Bun.sleep(700)
    s1.kill()
    await waitForExit(s1)

    const s2 = spawnServerWithState(statePath, port)
    try {
      await waitForHealth(base)
      const drain = await fetch(`${base}/api/rooms/QUEUE/pending-for-codex`, {
        headers: { 'x-bridge-token': sessionToken },
      })
      expect(drain.status).toBe(200)
      const { messages } = await drain.json() as { messages: { text: string }[] }
      expect(messages.length).toBeGreaterThan(0)
      expect(messages.some(m => m.text === 'hello from claude')).toBe(true)
    } finally {
      s2.kill()
      await waitForExit(s2)
      try { unlinkSync(statePath) } catch {}
    }
  }, 15000)
})

describe('message history log', () => {
  test('messages from codex are logged as jsonl', async () => {
    const port = getTestPort()
    const base = `http://127.0.0.1:${port}`
    const roomId = `LOG-TEST-${Date.now()}`

    const s = spawnServerWithState(`/tmp/bridge-log-test-state-${port}.json`, port)
    try {
      await waitForHealth(base)
      const create = await fetch(`${base}/api/rooms/${roomId}`, { method: 'POST' })
      const { sessionToken } = await create.json() as { sessionToken: string }

      // Codex sends a message
      await fetch(`${base}/api/rooms/${roomId}/from-codex`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': sessionToken },
        body: JSON.stringify({ message: 'hello from codex' }),
      })

      // Give the appendFileSync a moment to flush (it's sync, so this is just for safety)
      await Bun.sleep(100)

      const logPath = `/tmp/bridge-${roomId}.jsonl`
      expect(existsSync(logPath)).toBe(true)
      const content = readFileSync(logPath, 'utf8')
      const lines = content.trim().split('\n').map(l => JSON.parse(l))
      expect(lines.length).toBeGreaterThanOrEqual(1)
      const codexLine = lines.find((l: { kind: string }) => l.kind === 'codex→claude')
      expect(codexLine).toBeDefined()
      expect(codexLine.text).toBe('hello from codex')
      expect(codexLine.sender).toBe('codex')
    } finally {
      s.kill()
      await waitForExit(s)
      try { unlinkSync(`/tmp/bridge-${roomId}.jsonl`) } catch {}
      try { unlinkSync(`/tmp/bridge-log-test-state-${port}.json`) } catch {}
    }
  }, 15000)

  test('proactive and reply messages from claude are logged with distinct kinds', async () => {
    const roomId = `LOG-CLAUDE-${Date.now()}`
    const port = getTestPort()
    const base = `http://127.0.0.1:${port}`

    const s = spawnServerWithState(`/tmp/bridge-log-claude-state-${port}.json`, port)
    try {
      await waitForHealth(base)
      const create = await fetch(`${base}/api/rooms/${roomId}`, { method: 'POST' })
      const { sessionToken } = await create.json() as { sessionToken: string }

      // Proactive message
      await fetch(`${base}/api/rooms/${roomId}/from-claude`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': sessionToken },
        body: JSON.stringify({ text: 'proactive msg', proactive: true }),
      })

      // Reply (not proactive — this will also try to resolve a pending reply, but none exists; that's fine for the log test)
      await fetch(`${base}/api/rooms/${roomId}/from-claude`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': sessionToken },
        body: JSON.stringify({ text: 'reply msg', proactive: false }),
      })

      await Bun.sleep(100)

      const logPath = `/tmp/bridge-${roomId}.jsonl`
      expect(existsSync(logPath)).toBe(true)
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(lines.some((l: { kind: string }) => l.kind === 'claude→codex:proactive')).toBe(true)
      expect(lines.some((l: { kind: string }) => l.kind === 'claude→codex:reply')).toBe(true)
    } finally {
      s.kill()
      await waitForExit(s)
      try { unlinkSync(`/tmp/bridge-${roomId}.jsonl`) } catch {}
      try { unlinkSync(`/tmp/bridge-log-claude-state-${port}.json`) } catch {}
    }
  }, 15000)

  test('codex-backed assistant rooms log codex-peer kinds through the assistant lane', async () => {
    const roomId = `LOG-CODEX-PEER-${Date.now()}`
    const port = getTestPort()
    const base = `http://127.0.0.1:${port}`

    const s = spawnServerWithState(`/tmp/bridge-log-codex-peer-state-${port}.json`, port)
    try {
      await waitForHealth(base)
      const create = await fetch(`${base}/api/rooms/${roomId}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistantType: 'codex' }),
      })
      const { sessionToken } = await create.json() as { sessionToken: string }

      await fetch(`${base}/api/rooms/${roomId}/from-codex`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': sessionToken },
        body: JSON.stringify({ message: 'hello codex peer' }),
      })

      await fetch(`${base}/api/rooms/${roomId}/from-claude`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': sessionToken },
        body: JSON.stringify({ text: 'peer proactive', proactive: true }),
      })

      await fetch(`${base}/api/rooms/${roomId}/from-claude`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': sessionToken },
        body: JSON.stringify({ text: 'peer reply', proactive: false }),
      })

      await Bun.sleep(100)

      const logPath = `/tmp/bridge-${roomId}.jsonl`
      expect(existsSync(logPath)).toBe(true)
      const lines = readFileSync(logPath, 'utf8').trim().split('\n').map(l => JSON.parse(l))
      expect(lines.some((l: { kind: string }) => l.kind === 'codex→codex-peer')).toBe(true)
      expect(lines.some((l: { kind: string }) => l.kind === 'codex-peer→codex:proactive')).toBe(true)
      expect(lines.some((l: { kind: string }) => l.kind === 'codex-peer→codex:reply')).toBe(true)
    } finally {
      s.kill()
      await waitForExit(s)
      try { unlinkSync(`/tmp/bridge-${roomId}.jsonl`) } catch {}
      try { unlinkSync(`/tmp/bridge-log-codex-peer-state-${port}.json`) } catch {}
    }
  }, 15000)
})

describe('bridge core correctness', () => {
  test('rooms can be pre-created with a codex assistant type', async () => {
    const roomId = `ROOM-TYPE-${Date.now()}`

    const create = await fetch(`${BASE}/api/rooms/${roomId}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ assistantType: 'codex' }),
    })
    expect(create.status).toBe(201)

    const list = await fetch(`${BASE}/api/rooms`)
    expect(list.status).toBe(200)
    const rooms = await list.json() as Array<{
      id: string
      assistantType?: string
      assistantConnected?: boolean
      claudeConnected: boolean
      codexConnected: boolean
    }>
    const room = rooms.find(entry => entry.id === roomId)
    expect(room).toBeDefined()
    expect(room?.assistantType).toBe('codex')
    expect(room?.assistantConnected).toBe(false)
    expect(room?.claudeConnected).toBe(false)
    expect(room?.codexConnected).toBe(false)
  })

  test('long-poll round trip: codex → pending-for-claude → from-claude reply → codex poll resolves', async () => {
    const roomId = `LP-${Date.now()}`
    const port = getTestPort()
    const base = `http://127.0.0.1:${port}`

    const s = spawnServerWithState(`/tmp/bridge-core-state-${port}.json`, port, {
      CODEX_BRIDGE_LOG_DIR: '/tmp',
    })
    try {
      await waitForHealth(base)
      const create = await fetch(`${base}/api/rooms/${roomId}`, { method: 'POST' })
      const { sessionToken } = await create.json() as { sessionToken: string }

      // Codex POSTs /from-codex. The server delivers to Claude queue and
      // creates a pendingReply; the POST itself returns immediately with an `id`.
      const sendPromise = fetch(`${base}/api/rooms/${roomId}/from-codex`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': sessionToken },
        body: JSON.stringify({ message: 'codex question' }),
      }).then(r => r.json() as Promise<{ id: string }>)
      const { id: msgId } = await sendPromise
      expect(msgId).toBeDefined()

      // Claude-side drain: /pending-for-claude should deliver the codex message
      const drain = await fetch(`${base}/api/rooms/${roomId}/pending-for-claude?timeout=2000`, {
        headers: { 'x-bridge-token': sessionToken },
      })
      expect(drain.status).toBe(200)
      const { messages } = await drain.json() as { messages: { id: string; text: string }[] }
      expect(messages.length).toBeGreaterThan(0)
      const claudeMessage = messages.find(m => m.id === msgId)
      expect(claudeMessage).toBeDefined()
      expect(claudeMessage!.text).toBe('codex question')

      // Claude replies with replyTo pointing at codex's msgId
      const replyPromise = fetch(`${base}/api/rooms/${roomId}/from-claude`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-bridge-token': sessionToken },
        body: JSON.stringify({ text: 'claude answer', replyTo: msgId, proactive: false }),
      })

      // Codex's long-poll for this msgId should resolve with the reply
      const pollPromise = fetch(`${base}/api/rooms/${roomId}/poll-reply/${msgId}?timeout=5000`, {
        headers: { 'x-bridge-token': sessionToken },
      })

      const [, pollRes] = await Promise.all([replyPromise, pollPromise])
      expect(pollRes.status).toBe(200)
      const pollBody = await pollRes.json() as { timeout: boolean; reply: string | null }
      expect(pollBody.timeout).toBe(false)
      expect(pollBody.reply).toBe('claude answer')
    } finally {
      s.kill()
      await waitForExit(s)
      try { unlinkSync(`/tmp/bridge-core-state-${port}.json`) } catch {}
      try { unlinkSync(`/tmp/bridge-${roomId}.jsonl`) } catch {}
    }
  }, 15000)

  test('in-flight dedup: identical messages in quick succession share one reply', async () => {
    const roomId = `DEDUP-${Date.now()}`
    const port = getTestPort()
    const base = `http://127.0.0.1:${port}`

    const s = spawnServerWithState(`/tmp/bridge-dedup-state-${port}.json`, port, {
      CODEX_BRIDGE_LOG_DIR: '/tmp',
    })
    try {
      await waitForHealth(base)
      const create = await fetch(`${base}/api/rooms/${roomId}`, { method: 'POST' })
      const { sessionToken } = await create.json() as { sessionToken: string }

      // Fire two identical /from-codex POSTs concurrently
      const body = JSON.stringify({ message: 'same message' })
      const headers = { 'content-type': 'application/json', 'x-bridge-token': sessionToken }
      const [r1, r2] = await Promise.all([
        fetch(`${base}/api/rooms/${roomId}/from-codex`, { method: 'POST', headers, body }).then(r => r.json() as Promise<{ id: string }>),
        fetch(`${base}/api/rooms/${roomId}/from-codex`, { method: 'POST', headers, body }).then(r => r.json() as Promise<{ id: string }>),
      ])

      // Both calls should return the SAME id (dedup via inFlightCodexMessages)
      expect(r1.id).toBe(r2.id)

      // Verify claude-side: only ONE message in pending-for-claude (not two)
      const drain = await fetch(`${base}/api/rooms/${roomId}/pending-for-claude?timeout=2000`, {
        headers: { 'x-bridge-token': sessionToken },
      })
      const { messages } = await drain.json() as { messages: { id: string }[] }
      const matching = messages.filter(m => m.id === r1.id)
      expect(matching.length).toBe(1)
    } finally {
      s.kill()
      await waitForExit(s)
      try { unlinkSync(`/tmp/bridge-dedup-state-${port}.json`) } catch {}
      try { unlinkSync(`/tmp/bridge-${roomId}.jsonl`) } catch {}
    }
  }, 10000)
})
