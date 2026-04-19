# State Persistence — 설계 스펙 (P1)

**날짜**: 2026-04-19
**상태**: 설계 확정 대기
**범위**: codex-claude-bridge Step 2 (P1)
**전제**: P0(session-token) 완료 (main `ee8a805`)

---

## 배경 / 문제

`bridge-server.ts`는 전체 상태를 `rooms: Map<string, RoomState>` in-memory로 보관한다. Ctrl-C 또는 크래시 시:

1. `pendingReplies`의 Codex long-poll 대기자(최대 2분, `MAX_PENDING_REPLY_MS = 10 * 60 * 1000`)가 전부 `{ timeout: true, reply: null }`로 해제
2. `pendingForCodex` 큐(Claude proactive 메시지)가 증발
3. `RoomState.sessionToken`이 증발 → 실행 중이던 모든 MCP 프로세스가 401 → `process.exit(0)`
4. 방 자체가 증발 — `isTombstoned` 체크도 있었던 흔적을 모름

실제로 "Ctrl-C 한 번 = Codex의 진행 중 대화 유실 + 사용자가 `bridge-codex`/`bridge-claude`를 다시 실행해야 함". P0 final review에서 지적된 "세션 토큰 in-memory only" 제약의 근본 원인도 여기.

## 목표 / 비목표

### 목표

- 서버 기동 시 직전 상태를 복구해서 기존 MCP 프로세스가 **재연결 없이 계속 작동**
- `sessionToken` 포함 복구 → 기존 MCP가 다음 heartbeat에서 통과
- `pendingForCodex`(Claude proactive 큐) 복구 → Codex가 놓친 메시지 없음
- `pendingReplies`(Codex가 2분 기다리던 답장) 복구 → Codex 쪽 long-poll이 답장 반환 가능

### 비목표

- `pendingForClaude` 큐 영속화 — 이 큐는 Claude MCP의 long-poll(`pollLoop`)이 즉시 꺼내 가므로 파일에 남는 시간이 사실상 0. 재시작 순간 in-flight 메시지가 있었다면 이미 Claude가 받은 뒤. 추가로 `pendingForClaudeWaiters`(active HTTP 응답 객체)는 직렬화 불가.
- WebSocket `clients` 복구 — 연결은 TCP 수준에서 끊기므로 재연결 필요
- `pendingReplies.waiters`(active Response) 직렬화 — 응답 객체는 프로세스 재시작 간 전달 불가. 대신 `reply` 문자열만 보관하여 다음 poll에서 전달
- 크래시 safety (fsync per write) — best-effort, 드물게 손실 수용
- 다중 서버 인스턴스 지원 — 여전히 단일 프로세스

## 위협 모델 / 장애 시나리오

| 시나리오 | 현재 동작 | 목표 동작 |
|---|---|---|
| 사용자 Ctrl-C | 모든 상태 유실, MCP 모두 401로 exit | 재기동 시 상태 복구, MCP 계속 동작 |
| 크래시 (오류) | 위와 동일 | 마지막 persist 시점 이후 메시지 최대 500ms 분량 유실 가능 |
| 장시간 중단 (1시간+) | — | Load 시 `lastActivity` 기준 stale 방 skip |
| 파일 깨짐 | — | `.corrupted-<ts>`로 이동 후 빈 상태로 시작 |
| 파일 없음 (최초 실행) | — | 빈 상태로 시작 (정상) |
| 파일 쓰기 실패 | — | stderr 경고 후 계속 (best-effort) |

## 설계

### 영속 상태 스키마 (`SerializedRoom`)

```typescript
type SerializedPendingReply = {
  msgId: string
  createdAt: number
  normalizedMessage?: string
  reply?: string  // undefined if still pending; waiters discarded
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
  version: 1
  savedAt: number
  rooms: SerializedRoom[]
}
```

### 파일 경로

- 기본: `/tmp/codex-bridge-state.json`
- Override: `process.env.CODEX_BRIDGE_STATE_FILE`
- 깨진 파일 격리: `${file}.corrupted-${Date.now()}`

`/tmp`를 선택한 이유: macOS 재부팅 시 초기화 — 의도대로. 사용자가 재부팅했으면 방은 이미 죽었어야 함. 재부팅 survival이 필요하면 env로 override.

### 쓰기 전략: Debounced write-through

- 상태 변경 시점(아래 4곳)에서 `schedulePersist()` 호출
- 첫 호출 시 `setTimeout(persistState, 500)` 예약
- 이미 예약돼 있으면 무시 (타이머 여러 개 X)
- `persistState()`에서 타이머 클리어, 실제 쓰기, 실패 시 stderr 경고

**4개 trigger 지점**:
1. `getOrCreateRoom()` 에서 새 방 생성 직후
2. `from-codex` POST 이후 (새 `pendingReplies` 엔트리)
3. `from-claude` POST 이후 (resolveCodexReply로 `reply` 채워짐 OR `pendingForCodex`로 push)
4. `DELETE /api/rooms/:roomId`에서 방 제거 후
5. (Sub-decision) `dropPendingReply` 에서도? — 많이 호출되므로 debounce가 흡수. 예, 포함.

### 로드 전략: 기동 시 1회

```typescript
// After `const rooms = new Map<string, RoomState>()` (line ~93)
loadState()
```

`loadState()`:
1. 파일 없음 → return (빈 상태로 진행)
2. 파일 읽기 실패 → stderr 경고, return
3. JSON 파싱 실패 → 깨진 파일을 `.corrupted-<ts>`로 rename, stderr 경고, return
4. version 불일치 → skip (forward compat)
5. 각 `SerializedRoom` 순회:
   - `Date.now() - lastActivity > 1시간` → skip (stale)
   - 아닌 경우 `RoomState` 복원:
     - `pendingReplies` 내 `reply !== undefined` 엔트리는 `waiters: new Set()`로 복원 (다음 poll이 drain)
     - `reply === undefined` 엔트리는 **drop** (요청했던 Codex는 어차피 long-poll 타임아웃됨 — 복원해도 의미 없음)
     - `pendingForClaude`, `pendingForClaudeWaiters`, `clients`, `inFlightCodexMessages`는 빈 상태로 초기화

### 변경 영향 파일 (예상)

| 파일 | 변경량 |
|---|---|
| `bridge-server.ts` | ~80 lines (2개 helper 함수 + 5곳 schedulePersist 호출 + loadState 호출) |
| `bridge-server.test.ts` | ~60 lines (3개 신규 테스트) |

### 에러 처리 상세

| 시나리오 | 동작 |
|---|---|
| `writeFileSync` 실패 (디스크 full / permission) | `process.stderr.write('[bridge] persist failed: ...')`, 계속 운영 |
| `readFileSync` 실패 (권한 / I/O) | stderr 경고, 빈 상태로 시작 |
| JSON.parse 실패 | 깨진 파일을 `.corrupted-<ts>`로 rename, stderr 경고, 빈 상태로 시작 |
| `version` 필드 누락 또는 != 1 | stderr 경고 ("unsupported version"), 빈 상태로 시작 |
| stale room (lastActivity > 1h) | 조용히 skip (debug용 debug 로그는 선택) |

## P0 Known limitations와의 관계

P0가 README에 남긴 두 줄:
- "Session tokens are in-memory only..." → **이 단계 후 삭제 가능**
- "Reopening a room within the 10-second tombstone window..." → 영향 없음 (tombstone은 in-memory)

Task 말미에 이 줄 제거 + 새 줄 추가:
- "State is persisted to /tmp with up to ~500ms of message loss on crash"

## 테스트 전략

1. **Happy path 복구**: 방 생성 → persistState 강제 flush → 서버 종료 → 재기동 → 같은 roomId로 heartbeat 성공 (토큰 동일)
2. **Stale skip**: `lastActivity` 조작한 방 파일 만들어 기동 → 해당 방 복구 안 됨 (rooms.size 0)
3. **깨진 파일**: 유효하지 않은 JSON 기동 → `.corrupted-*` 파일 생성, 빈 상태로 진행
4. **pendingForCodex 복구**: proactive 메시지 쏨 → persist → 재기동 → `/pending-for-codex` GET에서 메시지 drain

Test harness 상속: 기존 `bridge-server.test.ts`의 `beforeAll` subprocess spawn 패턴 재사용. 각 테스트에서 state 파일 경로를 `CODEX_BRIDGE_STATE_FILE` env로 override하여 테스트 간 격리.

## Self-review 체크리스트

- [x] Placeholder/TBD 없음
- [x] `pendingForClaude` / `clients` / `waiters` 직렬화 불가 이유 명시
- [x] 쓰기 성능: debounce 500ms로 폭주 방지
- [x] 복구 범위: stale 1시간 cutoff 명시
- [x] 깨진 파일 격리 전략
- [x] Env var override 경로
- [x] P0 Known limitations와의 연결 명시
