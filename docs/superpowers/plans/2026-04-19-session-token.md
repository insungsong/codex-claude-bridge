# Session Token (P0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** bridge-server가 방마다 세션 토큰을 발급하고 민감 엔드포인트에서 검증하도록 구현하되, `bridge-codex <room-id>` / `bridge-claude <room-id>` UX는 불변 유지.

**Architecture:** 3지점 수정 — (1) wrapper가 `POST /api/rooms/:roomId`로 토큰 받아 PID 파일에 `roomId:token` write, (2) bridge-server가 `RoomState.sessionToken` + checkToken gate 추가, (3) MCP가 기존 `getRoomAndTokenFromPidFile()`이 파싱한 토큰을 `x-bridge-token` 헤더로 첨부. 기존 `getRoomAndTokenFromPidFile()` 파서와 PPID 체인 탐색 인프라는 건드리지 않음.

**Tech Stack:** Bun (runtime), TypeScript, `@modelcontextprotocol/sdk`, `node:crypto`, bun:test

**Spec reference:** `docs/superpowers/specs/2026-04-19-session-token-design.md`

---

## File Structure

| 파일 | 생성/수정 | 책임 |
|---|---|---|
| `bridge-server.ts` | 수정 | `RoomState.sessionToken` 필드, `checkToken()` 헬퍼, 엔드포인트별 gate |
| `bridge-server.test.ts` | **생성** | bridge-server를 subprocess로 띄워 토큰 동작 검증 |
| `bridge-codex` | 수정 | `curl`로 토큰 받고 `roomId:token` 포맷으로 PID 파일 write |
| `bridge-claude` | 수정 | 위와 동일 |
| `codex-mcp.ts` | 수정 | `getRoomAndTokenFromPidFile()` 결과에서 토큰 retain, `bridgeFetch()` 헬퍼, 401/404 시 exit |
| `claude-mcp.ts` | 수정 | 위와 동일 |
| `README.md` | 수정 | 수동 경로 예제를 wrapper 기반으로 단순화 |

**건드리지 않음**: `covering-bridge.ts`, `room-terminals.ts` — wrapper를 경유하므로 변경 불필요. `covering-bridge.ts`의 `closeRoom()`도 DELETE 엔드포인트가 토큰 면제이므로 수정 불필요 (스펙 참조).

---

## Task 1: Test harness — bridge-server를 random port로 spawn

**Files:**
- Create: `bridge-server.test.ts`

- [ ] **Step 1: 테스트 하네스 설정 + 가장 먼저 실패할 테스트 작성**

```typescript
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
  await waitForHealth(BASE)
})

afterAll(() => {
  server?.kill()
})

describe('session token', () => {
  test('POST /api/rooms/:roomId returns sessionToken (32 hex chars)', async () => {
    const res = await fetch(`${BASE}/api/rooms/ENG-TEST-1`, { method: 'POST' })
    expect(res.status).toBe(201)
    const body = await res.json()
    expect(body.sessionToken).toMatch(/^[a-f0-9]{32}$/)
  })
})
```

- [ ] **Step 2: 테스트 실행해서 실패 확인**

Run: `cd /Users/SONGINSUNG/Documents/codex-claude-bridge && bun test bridge-server.test.ts`
Expected: FAIL — `body.sessionToken` is undefined (현재 서버는 `new Response(null, { status: 201 })` 반환)

- [ ] **Step 3: 커밋 (실패하는 테스트만)**

```bash
cd /Users/SONGINSUNG/Documents/codex-claude-bridge
git add bridge-server.test.ts
git commit -m "test(session-token): harness + failing spec for POST response"
```

---

## Task 2: `RoomState.sessionToken` 필드 + POST 응답에 포함

**Files:**
- Modify: `bridge-server.ts:16` (import 추가), `bridge-server.ts:61-81` (`RoomState` 타입), `bridge-server.ts:108-126` (`getOrCreateRoom`), `bridge-server.ts:262-267` (POST 핸들러)

- [ ] **Step 1: `node:crypto` import 추가**

Add near the top of bridge-server.ts (alongside other imports):

```typescript
import { randomBytes } from 'node:crypto'
```

- [ ] **Step 2: `RoomState`에 `sessionToken` 필드 추가**

Modify `RoomState` (현재 line 61-81). 아래 필드를 clients 바로 위에 추가:

```typescript
type RoomState = {
  id: string
  createdAt: number
  claudeLastSeen: number
  codexLastSeen: number
  lastActivity: number
  pendingReplies: Map<string, PendingReply>
  inFlightCodexMessages: Map<string, string>
  pendingForCodex: { id: string; text: string }[]
  pendingForClaude: { id: string; text: string; sender: string; replyTo?: string }[]
  pendingForClaudeWaiters: Set<ClaudeWaiter>
  sessionToken: string   // ← 추가
  clients: Set<ServerWebSocket<unknown>>
}
```

- [ ] **Step 3: `getOrCreateRoom()`에서 토큰 생성**

Modify `getOrCreateRoom` (현재 line 108-126). `rooms.set(roomId, {...})` 블록 안에 `sessionToken` 추가:

```typescript
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
      sessionToken: randomBytes(16).toString('hex'),   // ← 추가
      clients: new Set(),
    })
    process.stderr.write(`[bridge] room created: ${roomId}\n`)
  }
  return rooms.get(roomId)!
}
```

- [ ] **Step 4: `POST /api/rooms/:roomId` 응답에 토큰 포함**

Modify 현재 line 263-267:

```typescript
// 기존
if (closeMatch && req.method === 'POST') {
  const roomId = decodeURIComponent(closeMatch[1])
  getOrCreateRoom(roomId)
  return new Response(null, { status: 201 })
}

// 변경 후
if (closeMatch && req.method === 'POST') {
  const roomId = decodeURIComponent(closeMatch[1])
  const room = getOrCreateRoom(roomId)
  return Response.json({ sessionToken: room.sessionToken }, { status: 201 })
}
```

- [ ] **Step 5: 테스트 실행 — Task 1의 테스트 통과 확인**

Run: `bun test bridge-server.test.ts`
Expected: PASS — `POST /api/rooms/:roomId returns sessionToken (32 hex chars)`

- [ ] **Step 6: 커밋**

```bash
git add bridge-server.ts
git commit -m "feat(session-token): RoomState.sessionToken + POST /api/rooms response"
```

---

## Task 3: `checkToken()` 헬퍼 + 첫 엔드포인트(/from-codex) gate

**Files:**
- Modify: `bridge-server.ts` (새 헬퍼 + `/from-codex` 핸들러)
- Modify: `bridge-server.test.ts` (테스트 추가)

- [ ] **Step 1: 실패 테스트 추가 — 토큰 없이 /from-codex 호출**

Append to `bridge-server.test.ts` within the `describe('session token', ...)` block:

```typescript
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
```

- [ ] **Step 2: 테스트 실행 — 3개 모두 실패 확인**

Run: `bun test bridge-server.test.ts`
Expected: 3 FAIL — 현재 `/from-codex`는 토큰 검증 없음

- [ ] **Step 3: `checkToken()` 헬퍼 추가**

Add right before `// ── HTTP server ──` section (around line 218 in current code):

```typescript
// ── Token authorization ──

function checkToken(req: Request, room: RoomState): Response | null {
  const provided = req.headers.get('x-bridge-token')
  if (!provided || provided !== room.sessionToken) {
    process.stderr.write(`[bridge] auth rejected: roomId=${room.id}\n`)
    return Response.json({ error: 'bad token' }, { status: 401 })
  }
  return null
}
```

- [ ] **Step 4: `/from-codex` 핸들러에 gate 추가**

Find the handler for `/from-codex` (search `sub === 'from-codex'`). 방 조회 직후, 본문 파싱 전에 gate 추가:

```typescript
// 기존 패턴 예 (현재 파일 참조)
if (sub === 'from-codex' && req.method === 'POST') {
  const room = getOrCreateRoom(roomId)   // 또는 rooms.get(roomId)
  const authFail = checkToken(req, room)  // ← 추가
  if (authFail) return authFail           // ← 추가
  // ... 기존 본문 처리
}
```

- [ ] **Step 5: 테스트 실행 — 3개 모두 통과 확인**

Run: `bun test bridge-server.test.ts`
Expected: 4 PASS (Task 1 + Task 3의 3개)

- [ ] **Step 6: 커밋**

```bash
git add bridge-server.ts bridge-server.test.ts
git commit -m "feat(session-token): checkToken helper + /from-codex gate"
```

---

## Task 4: 나머지 민감 엔드포인트에 gate 적용

**Files:**
- Modify: `bridge-server.ts` (나머지 민감 핸들러들)
- Modify: `bridge-server.test.ts` (cross-room 및 엔드포인트별 테스트)

대상 엔드포인트 (스펙 검증 표 기준, 토큰 필수 ✅):
- `/claude/connect` (POST, DELETE)
- `/codex/connect` (POST), `/codex/heartbeat` (POST)
- `/from-claude` (POST)
- `/poll-reply/:id` (GET)
- `/pending-for-claude` (GET)
- `/pending-for-codex` (GET)

토큰 면제 ❌: `/api/rooms/:roomId` (POST/DELETE), `/api/rooms` (GET), `/api/health`, `/`, `/ws/:roomId`, `/files/*`

- [ ] **Step 1: cross-room leak 방지 테스트 추가**

Append to `bridge-server.test.ts`:

```typescript
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
```

- [ ] **Step 2: 테스트 실행 — 새 테스트들 실패 확인**

Run: `bun test bridge-server.test.ts`
Expected: 새 테스트 중 일부 FAIL (heartbeat, cross-room, rotation)

- [ ] **Step 3: 나머지 민감 핸들러에 gate 적용**

각 핸들러에서 `rooms.get(roomId)` 또는 `getOrCreateRoom(roomId)`로 room 참조 확보 직후, 본문 로직 전에 아래 3줄을 삽입:

```typescript
const authFail = checkToken(req, room)
if (authFail) return authFail
```

적용 위치:
- `sub === 'claude/connect'` (POST / DELETE 모두)
- `sub === 'codex/connect' || sub === 'codex/heartbeat'`
- `sub === 'from-claude' && req.method === 'POST'`
- `sub === 'pending-for-claude' && req.method === 'GET'`
- `sub === 'pending-for-codex' && req.method === 'GET'`
- `sub.startsWith('poll-reply/') && req.method === 'GET'`

**예외처리**: `claude/connect`의 `POST`는 방 최초 생성 플로우를 통과한 후에만 heartbeat를 받으므로, 토큰 없이 들어오면 401로 거부 — MCP는 401 받으면 exit(0)하므로 순서가 맞다.

**주의**: 엔드포인트가 `getOrCreateRoom`을 쓰고 있는 경우, 토큰 검증 전에 방이 생성되면 tombstone이 깨진다. `claude/connect`는 tombstone 체크를 이미 하고 있으므로(`isTombstoned` 검사 line 302), 그 뒤에 토큰 검사를 넣는다. 순서:
  1. `isTombstoned` 체크 → 404
  2. `getOrCreateRoom`
  3. `checkToken`

- [ ] **Step 4: 테스트 실행 — 전부 통과 확인**

Run: `bun test bridge-server.test.ts`
Expected: 모든 테스트 PASS (최소 7개)

- [ ] **Step 5: 커밋**

```bash
git add bridge-server.ts bridge-server.test.ts
git commit -m "feat(session-token): enforce token on all sensitive endpoints"
```

---

## Task 5: `bridge-codex` wrapper 토큰 획득

**Files:**
- Modify: `bridge-codex`

- [ ] **Step 1: wrapper 교체**

현재 내용(17줄)을 다음으로 교체:

```sh
#!/bin/sh
# bridge-codex <ROOM_ID>
# Codex CLI를 Codex Bridge 룸에 연결해서 실행한다.
#
# Usage:
#   bridge-codex ENG-1234

ROOM="${1}"

if [ -z "$ROOM" ]; then
  echo "usage: bridge-codex <ROOM_ID>" >&2
  echo "  e.g. bridge-codex ENG-1234" >&2
  exit 1
fi

BRIDGE_URL="${CODEX_BRIDGE_URL:-http://localhost:8788}"

# 방 생성 + 토큰 획득
RESP=$(curl -s -f -X POST "$BRIDGE_URL/api/rooms/$ROOM" 2>&1)
if [ $? -ne 0 ]; then
  echo "bridge-codex: failed to reach bridge-server at $BRIDGE_URL" >&2
  echo "  $RESP" >&2
  exit 1
fi

TOKEN=$(echo "$RESP" | grep -o '"sessionToken":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  echo "bridge-codex: failed to parse token from response:" >&2
  echo "  $RESP" >&2
  exit 1
fi

printf "%s:%s" "$ROOM" "$TOKEN" > "/tmp/codex-bridge-room-$$"
exec codex --full-auto
```

- [ ] **Step 2: 실행 권한 확인**

Run: `ls -l /Users/SONGINSUNG/Documents/codex-claude-bridge/bridge-codex`
Expected: `-rwxr-xr-x ...` (실행 권한 유지). 없으면 `chmod +x bridge-codex`

- [ ] **Step 3: 수동 확인 — wrapper 동작 테스트 (Codex 실제 실행은 skip)**

별도 터미널에서 bridge-server 띄워둔 상태에서:

```bash
cd /Users/SONGINSUNG/Documents/codex-claude-bridge
CODEX_BRIDGE_URL=http://localhost:8788 sh -c '
ROOM=ENG-SMOKE-1
RESP=$(curl -s -X POST "$CODEX_BRIDGE_URL/api/rooms/$ROOM")
TOKEN=$(echo "$RESP" | grep -o "\"sessionToken\":\"[^\"]*\"" | cut -d"\"" -f4)
echo "token=$TOKEN"
[ -n "$TOKEN" ] && echo "OK" || echo "FAIL"
'
```

Expected: `token=<32 hex chars>` + `OK`

- [ ] **Step 4: 커밋**

```bash
git add bridge-codex
git commit -m "feat(session-token): bridge-codex wrapper fetches token"
```

---

## Task 6: `bridge-claude` wrapper 토큰 획득

**Files:**
- Modify: `bridge-claude`

- [ ] **Step 1: wrapper 교체**

현재 내용(17줄)을 다음으로 교체:

```sh
#!/bin/sh
# bridge-claude <ROOM_ID>
# Claude Code를 Codex Bridge 룸에 연결해서 실행한다.
#
# Usage:
#   bridge-claude ENG-1234

ROOM="${1}"

if [ -z "$ROOM" ]; then
  echo "usage: bridge-claude <ROOM_ID>" >&2
  echo "  e.g. bridge-claude ENG-1234" >&2
  exit 1
fi

BRIDGE_URL="${CODEX_BRIDGE_URL:-http://localhost:8788}"

RESP=$(curl -s -f -X POST "$BRIDGE_URL/api/rooms/$ROOM" 2>&1)
if [ $? -ne 0 ]; then
  echo "bridge-claude: failed to reach bridge-server at $BRIDGE_URL" >&2
  echo "  $RESP" >&2
  exit 1
fi

TOKEN=$(echo "$RESP" | grep -o '"sessionToken":"[^"]*"' | cut -d'"' -f4)
if [ -z "$TOKEN" ]; then
  echo "bridge-claude: failed to parse token from response:" >&2
  echo "  $RESP" >&2
  exit 1
fi

printf "%s:%s" "$ROOM" "$TOKEN" > "/tmp/claude-bridge-room-$$"
exec claude --dangerously-load-development-channels server:codex-bridge
```

- [ ] **Step 2: 실행 권한 확인**

Run: `ls -l /Users/SONGINSUNG/Documents/codex-claude-bridge/bridge-claude`
Expected: `-rwxr-xr-x ...`

- [ ] **Step 3: 커밋**

```bash
git add bridge-claude
git commit -m "feat(session-token): bridge-claude wrapper fetches token"
```

---

## Task 7: `codex-mcp.ts` — 토큰 retain + 헤더 첨부 + 401 처리

**Files:**
- Modify: `codex-mcp.ts:56-57` (destructure), `codex-mcp.ts` 전체 fetch 호출부

- [ ] **Step 1: 토큰 retain + 공통 헬퍼 추가**

Modify `codex-mcp.ts:56-66` (token 파싱 후 부분):

```typescript
// 변경 전
const { roomId: pidFileRoom } = getRoomAndTokenFromPidFile()
const ROOM_ID = process.env.CODEX_BRIDGE_ROOM || pidFileRoom

if (!ROOM_ID) {
  process.stderr.write(
    'codex-mcp: room not found — set CODEX_BRIDGE_ROOM or use covering-bridge to open rooms\n',
  )
  process.exit(1)
}

const BASE = `${BRIDGE_URL}/api/rooms/${encodeURIComponent(ROOM_ID)}`

// 변경 후
const { roomId: pidFileRoom, token: pidFileToken } = getRoomAndTokenFromPidFile()
const ROOM_ID = process.env.CODEX_BRIDGE_ROOM || pidFileRoom
const BRIDGE_TOKEN = process.env.CODEX_BRIDGE_TOKEN || pidFileToken

if (!ROOM_ID) {
  process.stderr.write(
    'codex-mcp: room not found — set CODEX_BRIDGE_ROOM or use bridge-codex to open rooms\n',
  )
  process.exit(1)
}

if (!BRIDGE_TOKEN) {
  process.stderr.write(
    'codex-mcp: session token not found — use bridge-codex wrapper or set CODEX_BRIDGE_TOKEN\n',
  )
  process.exit(1)
}

const BASE = `${BRIDGE_URL}/api/rooms/${encodeURIComponent(ROOM_ID)}`
const AUTH_HEADERS = { 'x-bridge-token': BRIDGE_TOKEN } as const

async function bridgeFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...AUTH_HEADERS },
  })
}

function exitOnAuthFail(status: number, where: string): void {
  if (status === 401 || status === 404) {
    process.stderr.write(`[codex-mcp] ${where} returned ${status} — exiting\n`)
    process.exit(0)
  }
}
```

- [ ] **Step 2: 모든 `fetch(...)` 호출을 `bridgeFetch(...)`로 교체**

`codex-mcp.ts` 내 `fetch(\`${BASE}` 패턴으로 된 모든 호출을 찾아 교체. 예:

```typescript
// 기존 예
const sendRes = await fetch(`${BASE}/from-codex`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: message.trim() }),
})

// 변경 후
const sendRes = await bridgeFetch('/from-codex', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ message: message.trim() }),
})
```

대상 위치 (현재 line 기준, 확인 필요):
- `send_to_claude` 내 `/from-codex` POST
- `send_to_claude` 내 `/poll-reply/:id` GET loop
- `check_claude_messages` 내 `/pending-for-codex` GET
- heartbeat 루프가 있으면 거기도

- [ ] **Step 3: 401/404 처리 삽입**

`sendRes`, `pollRes` 등 status 확인하는 곳마다 `exitOnAuthFail(res.status, 'send_to_claude')` 호출 추가:

```typescript
const sendRes = await bridgeFetch('/from-codex', { ... })
exitOnAuthFail(sendRes.status, 'send_to_claude/from-codex')
if (!sendRes.ok) { /* 기존 에러 처리 */ }
```

- [ ] **Step 4: 수동 smoke test**

별도 터미널에서 bridge-server 실행 후:

```bash
cd /Users/SONGINSUNG/Documents/codex-claude-bridge
# 방 하나 만들어두기
curl -s -X POST http://localhost:8788/api/rooms/SMOKE-CODEX
# PID 파일 수동 작성 (wrapper 없이)
TOKEN=$(curl -s -X POST http://localhost:8788/api/rooms/SMOKE-CODEX | grep -o '"sessionToken":"[^"]*"' | cut -d'"' -f4)
printf "SMOKE-CODEX:%s" "$TOKEN" > /tmp/codex-bridge-room-$$
# codex-mcp.ts 단독 실행 (MCP handshake 없이 startup 실패 메시지만 확인)
CODEX_BRIDGE_ROOM=SMOKE-CODEX CODEX_BRIDGE_TOKEN=$TOKEN timeout 2 bun codex-mcp.ts 2>&1 || true
rm /tmp/codex-bridge-room-$$
```

Expected: 토큰 관련 에러 메시지 없음 (MCP handshake는 stdin 없어서 hang되지만 우리는 startup만 검증)

- [ ] **Step 5: 커밋**

```bash
git add codex-mcp.ts
git commit -m "feat(session-token): codex-mcp sends x-bridge-token + exits on 401"
```

---

## Task 8: `claude-mcp.ts` — 토큰 retain + 헤더 첨부 + 401 처리

**Files:**
- Modify: `claude-mcp.ts:65-75` (destructure), 전체 fetch 호출부

- [ ] **Step 1: 토큰 retain + 공통 헬퍼 추가**

Modify `claude-mcp.ts:65-77`:

```typescript
// 변경 전
const { roomId: pidFileRoom } = getRoomAndTokenFromPidFile()
const ROOM_ID = process.env.CODEX_BRIDGE_ROOM || pidFileRoom
const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
// ...
if (!ROOM_ID) {
  process.stderr.write('claude-mcp: CODEX_BRIDGE_ROOM env var is required\n')
  process.exit(1)
}

const BASE = `${BRIDGE_URL}/api/rooms/${encodeURIComponent(ROOM_ID)}`

// 변경 후
const { roomId: pidFileRoom, token: pidFileToken } = getRoomAndTokenFromPidFile()
const ROOM_ID = process.env.CODEX_BRIDGE_ROOM || pidFileRoom
const BRIDGE_TOKEN = process.env.CODEX_BRIDGE_TOKEN || pidFileToken
const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
// ... (기존 POLL 상수들)

if (!ROOM_ID) {
  process.stderr.write('claude-mcp: CODEX_BRIDGE_ROOM env var is required\n')
  process.exit(1)
}

if (!BRIDGE_TOKEN) {
  process.stderr.write('claude-mcp: session token not found — use bridge-claude wrapper or set CODEX_BRIDGE_TOKEN\n')
  process.exit(1)
}

const BASE = `${BRIDGE_URL}/api/rooms/${encodeURIComponent(ROOM_ID)}`
const AUTH_HEADERS = { 'x-bridge-token': BRIDGE_TOKEN } as const

async function bridgeFetch(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...AUTH_HEADERS },
  })
}

function exitOnAuthFail(status: number, where: string): void {
  if (status === 401 || status === 404) {
    process.stderr.write(`[claude-mcp] ${where} returned ${status} — exiting\n`)
    process.exit(0)
  }
}
```

- [ ] **Step 2: 모든 `fetch(...)` 호출을 `bridgeFetch(...)`로 교체**

대상 위치:
- `reply` tool의 `/from-claude` POST
- `send_to_codex` tool의 `/from-claude` POST
- `heartbeat()` 내 `/claude/connect` POST
- `unregister()` 내 `/claude/connect` DELETE
- `pollLoop()` 내 `/pending-for-claude` GET

`heartbeat()`는 기존에 이미 404 → exit(0) 처리가 있음 (claude-mcp.ts:186-190). 이를 401도 포함하도록 확장:

```typescript
async function heartbeat() {
  try {
    const res = await bridgeFetch('/claude/connect', { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (res.status === 401 || res.status === 404) {
      process.stderr.write(`[claude-mcp] heartbeat returned ${res.status} — exiting\n`)
      process.exit(0)
    }
  } catch {}
}
```

- [ ] **Step 3: pollLoop 및 tool 호출부에 401/404 처리**

`pollLoop()` 내에서도 `exitOnAuthFail(res.status, 'pollLoop/pending-for-claude')` 추가.
`reply` / `send_to_codex` tool 내 `res.ok` 체크 전에 `exitOnAuthFail` 호출.

- [ ] **Step 4: 수동 smoke test**

```bash
cd /Users/SONGINSUNG/Documents/codex-claude-bridge
TOKEN=$(curl -s -X POST http://localhost:8788/api/rooms/SMOKE-CLAUDE | grep -o '"sessionToken":"[^"]*"' | cut -d'"' -f4)
CODEX_BRIDGE_ROOM=SMOKE-CLAUDE CODEX_BRIDGE_TOKEN=$TOKEN timeout 2 bun claude-mcp.ts 2>&1 || true
```

Expected: "session token not found" 에러가 안 나타남. pollLoop는 poll timeout 전에 timeout(2)에 의해 killed.

- [ ] **Step 5: 커밋**

```bash
git add claude-mcp.ts
git commit -m "feat(session-token): claude-mcp sends x-bridge-token + exits on 401"
```

---

## Task 9: 엔드투엔드 smoke test (문서화)

**Files:**
- Create: `docs/superpowers/plans/2026-04-19-session-token-smoke.md` (실행 기록용)

- [ ] **Step 1: 실제 방 생성 → wrapper 실행 → PID 파일 검증**

실행할 명령 시퀀스:

```bash
# Terminal 1: bridge-server
cd /Users/SONGINSUNG/Documents/codex-claude-bridge
bun bridge-server.ts

# Terminal 2: wrapper가 만드는 PID 파일 관찰
cd /Users/SONGINSUNG/Documents/codex-claude-bridge
# bridge-codex ENG-E2E 를 실행하지 말고, 그 내부 로직만 실행:
sh -c '
ROOM=ENG-E2E
RESP=$(curl -s -X POST http://localhost:8788/api/rooms/$ROOM)
TOKEN=$(echo "$RESP" | grep -o "\"sessionToken\":\"[^\"]*\"" | cut -d"\"" -f4)
echo "token=$TOKEN"
printf "%s:%s" "$ROOM" "$TOKEN" > /tmp/codex-bridge-room-$$
echo "pidfile=/tmp/codex-bridge-room-$$"
cat /tmp/codex-bridge-room-$$
echo
rm /tmp/codex-bridge-room-$$
'
```

Expected 출력:
```
token=<32 hex chars>
pidfile=/tmp/codex-bridge-room-<pid>
ENG-E2E:<32 hex chars>
```

- [ ] **Step 2: 토큰 없이 from-codex 시도 → 401 확인**

```bash
curl -s -w "%{http_code}\n" -X POST http://localhost:8788/api/rooms/ENG-E2E/from-codex \
  -H "content-type: application/json" \
  -d '{"message":"no auth"}'
```

Expected 마지막 줄: `401`

- [ ] **Step 3: 올바른 토큰으로 from-codex → 성공**

```bash
TOKEN=$(curl -s -X POST http://localhost:8788/api/rooms/ENG-E2E2 | grep -o '"sessionToken":"[^"]*"' | cut -d'"' -f4)
# curl POST는 응답 기다리느라 long-poll에 걸릴 수 있으므로 timeout
timeout 3 curl -s -w "%{http_code}\n" -X POST http://localhost:8788/api/rooms/ENG-E2E2/from-codex \
  -H "content-type: application/json" \
  -H "x-bridge-token: $TOKEN" \
  -d '{"message":"hello"}' || echo "(timeout expected if pending-for-claude is unopened)"
```

Expected: 200 이상의 성공 status (또는 long-poll이 Codex가 안 붙어있어 timeout — 이 경우 timeout이 정상)

- [ ] **Step 4: server 종료 후 커밋 (smoke test 기록은 별도 파일 X, plan에 inline 포함)**

Terminal 1에서 `Ctrl+C`. 변경 파일이 없다면 skip. 

---

## Task 10: README 업데이트

**Files:**
- Modify: `README.md` (Setup 섹션의 수동 경로 예제)

- [ ] **Step 1: README의 "manual per-room launch" 섹션 수정**

기존 README.md의 "Option B — manual per-room launch" 섹션(현재 line 119-137 근방)을 다음으로 교체:

```markdown
### Option B — manual per-room launch

Start the central server once:

\`\`\`bash
bun bridge-server.ts
\`\`\`

Then for each room, open two terminals and run the wrapper scripts:

\`\`\`bash
# Terminal 1 — Claude
./bridge-claude ENG-1234

# Terminal 2 — Codex
./bridge-codex ENG-1234
\`\`\`

The wrappers register the room with the bridge server, receive a session token, write it to `/tmp/(claude|codex)-bridge-room-$$`, and exec the respective CLI. The MCP processes then authenticate every request with this token.

For environments where the wrapper can't be used (e.g., custom MCP configs), you can manually obtain a token:

\`\`\`bash
TOKEN=$(curl -s -X POST http://localhost:8788/api/rooms/ENG-1234 | grep -o '"sessionToken":"[^"]*"' | cut -d'"' -f4)
CODEX_BRIDGE_ROOM=ENG-1234 CODEX_BRIDGE_TOKEN=$TOKEN codex --full-auto
\`\`\`
```

- [ ] **Step 2: "Known limitations" 섹션에서 토큰 관련 항목 추가 (선택)**

기존 섹션에 한 줄 추가:

```markdown
- Session tokens are in-memory only: restarting `bridge-server` invalidates tokens issued before the restart. Existing MCP processes will exit on next heartbeat (401), and wrappers need to be re-run.
```

- [ ] **Step 3: 커밋**

```bash
git add README.md
git commit -m "docs(session-token): update manual launch instructions"
```

---

## Task 11: 최종 검증 — 전체 테스트 실행 + tree 확인

- [ ] **Step 1: 전체 테스트 slate 실행**

```bash
cd /Users/SONGINSUNG/Documents/codex-claude-bridge
bun test
```

Expected: `room-terminals.test.ts`의 기존 테스트 + `bridge-server.test.ts`의 7개 이상 새 테스트, 전부 PASS

- [ ] **Step 2: 커밋 로그 검수**

```bash
git log --oneline main.. 2>/dev/null || git log --oneline -10
```

Expected: 9개 내외의 atomic commit (test harness / RoomState / checkToken / endpoints / bridge-codex / bridge-claude / codex-mcp / claude-mcp / README)

- [ ] **Step 3: 남은 dirty state 확인**

```bash
git status
```

Expected: `nothing to commit, working tree clean`

---

## Self-Review Checklist

**Spec coverage:**
- [x] RoomState.sessionToken 필드 — Task 2
- [x] POST /api/rooms 응답에 토큰 — Task 2
- [x] checkToken 헬퍼 — Task 3
- [x] /from-codex gate — Task 3
- [x] /from-claude, heartbeat, poll, pending-for-* gate — Task 4
- [x] /api/rooms, /api/health, / 비인증 유지 — Task 4 테스트
- [x] Cross-room leak 방지 — Task 4 테스트
- [x] Tombstone 윈도우 내 재생성 시 이전 토큰 401 — Task 4 테스트
- [x] Wrapper가 토큰을 PID 파일에 write — Task 5, 6
- [x] MCP가 토큰 retain + 헤더 첨부 — Task 7, 8
- [x] 401/404 시 MCP exit(0) — Task 7, 8
- [x] README 업데이트 — Task 10

**Placeholder scan:** 모든 코드 블록에 실제 구현. TBD/TODO 없음. `// ...` 는 "기존 로직 유지" 지시용으로만 사용.

**Type consistency:**
- `BRIDGE_TOKEN` 상수명 Task 7, 8 일관
- `bridgeFetch` / `exitOnAuthFail` 함수명 일관
- `x-bridge-token` 헤더명 일관 (Task 3 서버, Task 7/8 클라이언트)
- `sessionToken` JSON 키명 일관 (Task 2 서버, Task 5/6 wrapper, Task 9 smoke)

**주의사항:**
- Task 4의 "tombstone 만료 10초 대기" 테스트는 15초 timeout 필요 (bun:test `test(..., timeoutMs)` 서드 인자)
- Task 7, 8의 MCP startup 테스트는 자동화 어려움 — 수동 smoke로 대체
- Wrapper (shell script)는 TDD 대신 수동 검증 채택 (shell test 인프라 부재)
