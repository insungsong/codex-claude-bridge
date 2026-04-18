// bridge-server.test.ts
import { describe, expect, test, beforeAll, afterAll } from 'bun:test'
import type { Subprocess } from 'bun'

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
})
