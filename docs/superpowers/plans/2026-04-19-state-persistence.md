# State Persistence (P1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** `bridge-server.ts`의 in-memory room state를 `/tmp/codex-bridge-state.json`에 write-through 해서, Ctrl-C / 크래시 이후 재기동 시 기존 방·토큰·큐를 복구. 실행 중인 MCP 프로세스가 재연결 없이 계속 작동.

**Architecture:** (1) JSON 파일 기반 single-file persistence, (2) 500ms debounced write on state changes, (3) 기동 시 1회 load with stale filter (1시간 cutoff), (4) 깨진 파일은 `.corrupted-<ts>`로 격리.

**Tech Stack:** Bun runtime, `node:fs` (readFileSync/writeFileSync/renameSync), bun:test

**Spec:** `docs/superpowers/specs/2026-04-19-state-persistence-design.md`

---

## File Structure

| 파일 | 변경 |
|---|---|
| `bridge-server.ts` | `PersistedState`/`SerializedRoom` 타입, `STATE_FILE` 상수, `loadState()`/`persistState()`/`schedulePersist()` 헬퍼, 5곳 trigger 호출, 기동 시 `loadState()` 호출 |
| `bridge-server.test.ts` | 4개 신규 테스트 in describe block `state persistence` |
| `README.md` | Known limitations 업데이트 (P0의 "in-memory only" 줄 수정) |

---

## Task 1: Test harness — state 파일 격리

**Files:**
- Modify: `bridge-server.test.ts`

- [ ] **Step 1: Add helper for state-file-scoped subprocess spawn**

Near the top of `bridge-server.test.ts`, after the existing imports, add:

```typescript
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
```

- [ ] **Step 2: Run existing tests to confirm no regression**

```bash
cd /Users/SONGINSUNG/Documents/codex-claude-bridge-state-persistence
bun test bridge-server.test.ts
```

Expected: 8 pass / 0 fail (the existing session-token tests should still pass — this import is a no-op addition).

- [ ] **Step 3: Commit**

```bash
git add bridge-server.test.ts
git commit -m "test(persistence): add spawnServerWithState helper"
```

---

## Task 2: State types + STATE_FILE constant

**Files:**
- Modify: `bridge-server.ts`

- [ ] **Step 1: Add fs imports** near existing imports:

```typescript
import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
```

(Existing `readFileSync` import from earlier parts of the file may already be present — if so, extend the existing import rather than duplicating.)

- [ ] **Step 2: Add `STATE_FILE` constant** near the `PORT` constant (currently around line 19):

```typescript
const STATE_FILE = process.env.CODEX_BRIDGE_STATE_FILE ?? '/tmp/codex-bridge-state.json'
const PERSIST_VERSION = 1
const STALE_CUTOFF_MS = 60 * 60 * 1000  // 1 hour
const PERSIST_DEBOUNCE_MS = 500
```

- [ ] **Step 3: Add serialization types** after the existing `type RoomState` block:

```typescript
type SerializedPendingReply = {
  msgId: string
  createdAt: number
  normalizedMessage?: string
  reply?: string
}

type SerializedRoom = {
  id: string
  createdAt: number
  sessionToken: string
  lastActivity: number
  pendingForCodex: { id: string; text: string }[]
  pendingReplies: SerializedPendingReply[]
}

type PersistedState = {
  version: number
  savedAt: number
  rooms: SerializedRoom[]
}
```

- [ ] **Step 4: Compile check** (no implementation yet, just types + constants):

```bash
cd /Users/SONGINSUNG/Documents/codex-claude-bridge-state-persistence
bun test bridge-server.test.ts
```

Expected: 8 pass / 0 fail (types are declaration-only, no behavior change).

- [ ] **Step 5: Commit**

```bash
git add bridge-server.ts
git commit -m "feat(persistence): types + STATE_FILE constants"
```

---

## Task 3: `persistState()` + `schedulePersist()` helpers

**Files:**
- Modify: `bridge-server.ts`

- [ ] **Step 1: Add helpers** after the `touchRoom` function (currently around line 128) and before the `// ── Utilities ──` section. Position: just after `touchRoom`, before `let seq = 0`:

```typescript
// ── Persistence ──

function serializeRoom(room: RoomState): SerializedRoom {
  const serializedReplies: SerializedPendingReply[] = []
  for (const [msgId, pending] of room.pendingReplies) {
    serializedReplies.push({
      msgId,
      createdAt: pending.createdAt,
      normalizedMessage: pending.normalizedMessage,
      reply: pending.reply,
    })
  }
  return {
    id: room.id,
    createdAt: room.createdAt,
    sessionToken: room.sessionToken,
    lastActivity: room.lastActivity,
    pendingForCodex: [...room.pendingForCodex],
    pendingReplies: serializedReplies,
  }
}

let persistTimer: Timer | null = null

function persistState(): void {
  persistTimer = null
  try {
    const state: PersistedState = {
      version: PERSIST_VERSION,
      savedAt: Date.now(),
      rooms: Array.from(rooms.values()).map(serializeRoom),
    }
    writeFileSync(STATE_FILE, JSON.stringify(state), 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[bridge] persist failed: ${msg}\n`)
  }
}

function schedulePersist(): void {
  if (persistTimer !== null) return
  persistTimer = setTimeout(persistState, PERSIST_DEBOUNCE_MS)
}
```

- [ ] **Step 2: Run tests to confirm no regression**

```bash
bun test bridge-server.test.ts
```

Expected: 8 pass / 0 fail (helpers added but not called anywhere).

- [ ] **Step 3: Commit**

```bash
git add bridge-server.ts
git commit -m "feat(persistence): persistState + schedulePersist helpers"
```

---

## Task 4: Wire `schedulePersist()` into state changes

**Files:**
- Modify: `bridge-server.ts`

Call `schedulePersist()` at 5 locations:

- [ ] **Step 1: In `getOrCreateRoom`** — right after `process.stderr.write('[bridge] room created: ...')` inside the `!rooms.has(roomId)` block:

```typescript
process.stderr.write(`[bridge] room created: ${roomId}\n`)
schedulePersist()
```

- [ ] **Step 2: In `dropPendingReply`** — at the end of the function (after `pending.waiters.clear()`):

```typescript
function dropPendingReply(room: RoomState, msgId: string) {
  const pending = room.pendingReplies.get(msgId)
  if (!pending) return
  room.pendingReplies.delete(msgId)
  if (pending.normalizedMessage && room.inFlightCodexMessages.get(pending.normalizedMessage) === msgId) {
    room.inFlightCodexMessages.delete(pending.normalizedMessage)
  }
  for (const w of pending.waiters) w.cleanup()
  pending.waiters.clear()
  schedulePersist()  // ← new
}
```

- [ ] **Step 3: In `resolveCodexReply`** — after `pending.reply = text`:

```typescript
function resolveCodexReply(room: RoomState, replyToId: string | undefined, text: string) {
  if (!replyToId) return
  const pending = room.pendingReplies.get(replyToId)
  if (!pending || pending.reply !== undefined) return
  pending.reply = text
  schedulePersist()  // ← new
  if (pending.waiters.size > 0) {
    const waiters = Array.from(pending.waiters)
    dropPendingReply(room, replyToId)
    for (const w of waiters) w.resolve(Response.json({ timeout: false, reply: text }))
  }
}
```

- [ ] **Step 4: In the `/from-codex` POST handler** — after a new `PendingReply` is pushed into `room.pendingReplies`. Find the block that looks like:

```typescript
room.pendingReplies.set(id, { ... })
```

Add `schedulePersist()` immediately after. (There may also be a deliverMessageToClaude call — persist comes AFTER the room state mutation regardless.)

- [ ] **Step 5: In the `/from-claude` POST handler for proactive path** — find the block:

```typescript
if (proactive) {
  room.pendingForCodex.push({ id, text })
  ...
}
```

Add `schedulePersist()` after `room.pendingForCodex.push(...)`.

- [ ] **Step 6: In the `DELETE /api/rooms/:roomId` handler** — after `rooms.delete(roomId)`:

```typescript
rooms.delete(roomId)
markDeleted(roomId)
schedulePersist()  // ← new
```

- [ ] **Step 7: Run tests**

```bash
bun test bridge-server.test.ts
```

Expected: 8 pass / 0 fail. No new behavior visible from outside yet — persist writes file but no test reads it yet.

- [ ] **Step 8: Commit**

```bash
git add bridge-server.ts
git commit -m "feat(persistence): schedulePersist on state mutations (6 sites)"
```

---

## Task 5: `loadState()` + boot call

**Files:**
- Modify: `bridge-server.ts`

- [ ] **Step 1: Add `loadState` helper** right below `schedulePersist`:

```typescript
function loadState(): void {
  if (!existsSync(STATE_FILE)) return
  let raw: string
  try {
    raw = readFileSync(STATE_FILE, 'utf8')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[bridge] state read failed: ${msg}\n`)
    return
  }
  let parsed: PersistedState
  try {
    parsed = JSON.parse(raw) as PersistedState
  } catch {
    const corruptPath = `${STATE_FILE}.corrupted-${Date.now()}`
    try { renameSync(STATE_FILE, corruptPath) } catch {}
    process.stderr.write(`[bridge] state file corrupt; moved to ${corruptPath}\n`)
    return
  }
  if (parsed.version !== PERSIST_VERSION) {
    process.stderr.write(`[bridge] state version ${parsed.version} != ${PERSIST_VERSION}, skipping\n`)
    return
  }
  const now = Date.now()
  let restored = 0
  let skipped = 0
  for (const sr of parsed.rooms) {
    if (now - sr.lastActivity > STALE_CUTOFF_MS) {
      skipped++
      continue
    }
    const pendingReplies = new Map<string, PendingReply>()
    for (const sp of sr.pendingReplies) {
      // Drop entries with no reply — the Codex that was waiting has already timed out.
      if (sp.reply === undefined) continue
      pendingReplies.set(sp.msgId, {
        createdAt: sp.createdAt,
        normalizedMessage: sp.normalizedMessage,
        reply: sp.reply,
        waiters: new Set(),
      })
    }
    rooms.set(sr.id, {
      id: sr.id,
      createdAt: sr.createdAt,
      claudeLastSeen: 0,
      codexLastSeen: 0,
      lastActivity: sr.lastActivity,
      pendingReplies,
      inFlightCodexMessages: new Map(),
      pendingForCodex: [...sr.pendingForCodex],
      pendingForClaude: [],
      pendingForClaudeWaiters: new Set(),
      sessionToken: sr.sessionToken,
      clients: new Set(),
    })
    restored++
  }
  process.stderr.write(`[bridge] state loaded: ${restored} room(s) restored, ${skipped} stale\n`)
}
```

- [ ] **Step 2: Call `loadState()` at module init**

Find the place where `const rooms = new Map<string, RoomState>()` is declared (currently around line 93). After that line, add:

```typescript
const rooms = new Map<string, RoomState>()
loadState()  // ← new, restore from disk on boot
```

(Or place after all other helpers if linting complains about forward references — the function hoists but the `rooms` reference inside `loadState` resolves lexically, so placement doesn't matter for runtime. Just keep it where it reads naturally.)

- [ ] **Step 3: Run tests**

```bash
bun test bridge-server.test.ts
```

Expected: 8 pass / 0 fail. Each test spawns a fresh subprocess with a unique `CODEX_BRIDGE_STATE_FILE` (if set) or the default — should work either way since files don't exist between fresh test runs.

**Important**: because the default `STATE_FILE=/tmp/codex-bridge-state.json` is shared across test runs, existing tests MIGHT pick up stale data from a previous dev run. Verify by running tests twice in a row — both should pass with 8/8. If they don't, we need to add an `afterAll` cleanup or force `CODEX_BRIDGE_STATE_FILE=/dev/null` in `spawnServer`.

Preemptive fix: update the existing `beforeAll` in `bridge-server.test.ts` to set `CODEX_BRIDGE_STATE_FILE` to a unique temp path (or `/dev/null` for discard):

```typescript
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
  ...
```

And update `afterAll`:

```typescript
afterAll(async () => {
  server?.kill()
  await server?.exited
  // Cleanup test state file
  try { unlinkSync(`/tmp/codex-bridge-state-test-${PORT}.json`) } catch {}
})
```

Make sure `unlinkSync` is imported from Task 1's `import { ..., unlinkSync } from 'fs'`.

- [ ] **Step 4: Commit**

```bash
git add bridge-server.ts bridge-server.test.ts
git commit -m "feat(persistence): loadState on boot + isolate test state files"
```

---

## Task 6: New tests for persistence scenarios

**Files:**
- Modify: `bridge-server.test.ts`

- [ ] **Step 1: Add `describe('state persistence', ...)` block** at the end of the file (after the existing `describe('session token', ...)` block):

```typescript
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
      // A quarantined file should exist alongside
      // (we can't easily glob, but can check the original is gone)
      expect(existsSync(statePath)).toBe(false)
    } finally {
      s.kill()
      await s.exited
      // Cleanup any .corrupted-* files
      // (fs glob isn't trivial in Bun; accept the leftover in /tmp for this test)
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
```

- [ ] **Step 2: Run tests**

```bash
bun test bridge-server.test.ts
```

Expected: **12 pass / 0 fail** (8 existing + 4 new).

- [ ] **Step 3: Commit**

```bash
git add bridge-server.test.ts
git commit -m "test(persistence): 4 tests — token restore, stale skip, corrupt quarantine, queue persist"
```

---

## Task 7: Update README

**Files:**
- Modify: `README.md`

- [ ] **Step 1: Replace the P0 Known limitations lines about in-memory tokens**

In `README.md`, find the bullet:
```
- Session tokens are in-memory only: restarting `bridge-server` invalidates all tokens issued before the restart. Running MCP processes will exit on next heartbeat (401 or 404), and wrapper scripts need to be re-run to obtain new tokens.
```

Replace with:
```
- State persistence is best-effort with up to ~500ms of message loss on crash: state writes are debounced 500ms after each mutation, so a crash within that window drops the most recent proactive message or reply. Tokens, rooms, and queues are restored on next boot — running MCP processes continue working across graceful restarts.
```

Keep the tombstone-window bullet unchanged.

- [ ] **Step 2: Update Environment variables table**

Find the `## Environment variables` section. Add one row:

```markdown
| `CODEX_BRIDGE_STATE_FILE` | `/tmp/codex-bridge-state.json` | Path to the JSON persistence file. Set to `/dev/null` to disable persistence |
```

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs(persistence): update limitations + env var table"
```

---

## Task 8: Final verification

- [ ] **Step 1: Full test suite**

```bash
cd /Users/SONGINSUNG/Documents/codex-claude-bridge-state-persistence
bun test
```

Expected: 12+ pass / 0 fail total (bridge-server.test.ts + room-terminals.test.ts = 12 + 2 = 14 total).

- [ ] **Step 2: Git log review**

```bash
git log --oneline main..HEAD
```

Expected: 7 commits — harness helper, types, persistState helpers, schedulePersist wiring, loadState, 4 tests, README.

- [ ] **Step 3: Dirty tree check**

```bash
git status
```

Expected: `nothing to commit, working tree clean`

---

## Self-Review Checklist

**Spec coverage:**
- [x] SerializedRoom / PersistedState types — Task 2
- [x] STATE_FILE constant + env override — Task 2
- [x] serializeRoom helper — Task 3
- [x] persistState + debounce — Task 3
- [x] schedulePersist wiring at 5+ mutation sites — Task 4
- [x] loadState on boot with stale filter — Task 5
- [x] Corrupted file quarantine — Task 5
- [x] pendingReplies without reply dropped on load — Task 5
- [x] Test harness isolation (per-test state file) — Task 5 Step 3
- [x] 4 persistence tests — Task 6
- [x] README updated — Task 7

**Placeholder scan:** No TBD. All code shown inline.

**Type consistency:** `SerializedPendingReply`/`SerializedRoom`/`PersistedState` used consistently.
