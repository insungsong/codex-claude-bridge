// bridge-server.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import type { Subprocess } from 'bun'
import { unlinkSync, existsSync, writeFileSync, readFileSync } from 'fs'

function spawnServerWithState(statePath: string, port: number) {
  return Bun.spawn(['bun', 'bridge-server.ts'], {
    env: {
      ...process.env,
      CODEX_BRIDGE_PORT: String(port),
      CODEX_BRIDGE_STATE_FILE: statePath,
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
}

let server: Subprocess | null = null
let PORT = 0
let BASE = ''

async function waitForHealth(base: string, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(200) })
      if (res.ok) return
    } catch {}
    await Bun.sleep(50)
  }
  throw new Error('bridge-server did not become ready')
}

beforeAll(async () => {
  PORT = 20000 + Math.floor(Math.random() * 40000)
  BASE = `http://127.0.0.1:${PORT}`
  server = Bun.spawn(['bun', 'bridge-server.ts'], {
    env: {
      ...process.env,
      CODEX_BRIDGE_PORT: String(PORT),
      CODEX_BRIDGE_STATE_FILE: `/tmp/codex-bridge-state-test-${PORT}.json`,  // ← new
    },
    stdout: 'ignore',
    stderr: 'ignore',
  })
  try {
    await waitForHealth(BASE)
  } catch (e) {
    server.kill()
    throw e
  }
})

afterAll(async () => {
  server?.kill()
  await server?.exited
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
    const port = 30000 + Math.floor(Math.random() * 20000)
    const base = `http://127.0.0.1:${port}`

    const s1 = spawnServerWithState(statePath, port)
    await waitForHealth(base)
    const create = await fetch(`${base}/api/rooms/PERSIST-A`, { method: 'POST' })
    const { sessionToken } = await create.json() as { sessionToken: string }

    // Trigger the debounced persist — wait > 500ms
    await Bun.sleep(700)

    s1.kill()
    await s1.exited

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
      await s2.exited
      try { unlinkSync(statePath) } catch {}
    }
  }, 15000)

  test('stale rooms (>1h lastActivity) are skipped on load', async () => {
    const statePath = `/tmp/codex-bridge-state-stale-test-${Date.now()}.json`
    const port = 30000 + Math.floor(Math.random() * 20000)
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
      await s.exited
      try { unlinkSync(statePath) } catch {}
    }
  }, 10000)

  test('corrupted state file is quarantined, server starts clean', async () => {
    const statePath = `/tmp/codex-bridge-state-corrupt-test-${Date.now()}.json`
    const port = 30000 + Math.floor(Math.random() * 20000)
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
      await s.exited
      // Cleanup any .corrupted-* files (best-effort)
    }
  }, 10000)

  test('pendingForCodex queue persists and is drained after restart', async () => {
    const statePath = `/tmp/codex-bridge-state-queue-test-${Date.now()}.json`
    const port = 30000 + Math.floor(Math.random() * 20000)
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
    await s1.exited

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
      await s2.exited
      try { unlinkSync(statePath) } catch {}
    }
  }, 15000)
})

describe('message history log', () => {
  test('messages from codex are logged as jsonl', async () => {
    const port = 30000 + Math.floor(Math.random() * 20000)
    const base = `http://127.0.0.1:${port}`
    const roomId = `LOG-TEST-${Date.now()}`

    const s = Bun.spawn(['bun', 'bridge-server.ts'], {
      env: {
        ...process.env,
        CODEX_BRIDGE_PORT: String(port),
        CODEX_BRIDGE_STATE_FILE: `/tmp/bridge-log-test-state-${port}.json`,
        // CODEX_BRIDGE_LOG_DIR unset -> defaults to /tmp
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
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
      await s.exited
      try { unlinkSync(`/tmp/bridge-${roomId}.jsonl`) } catch {}
      try { unlinkSync(`/tmp/bridge-log-test-state-${port}.json`) } catch {}
    }
  }, 15000)

  test('proactive and reply messages from claude are logged with distinct kinds', async () => {
    const roomId = `LOG-CLAUDE-${Date.now()}`
    const port = 30000 + Math.floor(Math.random() * 20000)
    const base = `http://127.0.0.1:${port}`

    const s = Bun.spawn(['bun', 'bridge-server.ts'], {
      env: {
        ...process.env,
        CODEX_BRIDGE_PORT: String(port),
        CODEX_BRIDGE_STATE_FILE: `/tmp/bridge-log-claude-state-${port}.json`,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    })
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
      await s.exited
      try { unlinkSync(`/tmp/bridge-${roomId}.jsonl`) } catch {}
      try { unlinkSync(`/tmp/bridge-log-claude-state-${port}.json`) } catch {}
    }
  }, 15000)
})
