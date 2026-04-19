// bridge-server.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import type { Subprocess } from 'bun'
import { unlinkSync, existsSync, writeFileSync } from 'fs'

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
    env: { ...process.env, CODEX_BRIDGE_PORT: String(PORT) },
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
