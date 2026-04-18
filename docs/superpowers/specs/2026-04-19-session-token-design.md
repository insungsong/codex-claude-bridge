# Session Token — 설계 스펙 (P0)

**날짜**: 2026-04-19
**상태**: 설계 확정 대기
**범위**: codex-claude-bridge Step 1 (P0)
**다음 단계**: writing-plans 스킬로 구현 계획 작성

---

## 배경 / 문제

`bridge-server.ts:64-65`에 session token 설계가 주석으로 이미 기록돼 있고, 두 MCP 프로세스(`codex-mcp.ts:38-54`, `claude-mcp.ts:49-63`)에는 PID 파일을 `roomId:token` 포맷으로 파싱하는 `getRoomAndTokenFromPidFile()` 헬퍼가 이미 구현돼 있다. 하지만:

1. **Wrapper**(`bridge-codex`, `bridge-claude`)는 토큰 없이 `roomId`만 PID 파일에 기록
2. **MCP**는 파싱된 `token`을 destructuring에서 즉시 버림 (`const { roomId: pidFileRoom } = ...`)
3. **Server**는 `RoomState`에 `sessionToken` 필드도 없고, 전체 코드에서 `sessionToken` 문자열이 단 한 번도 등장하지 않음

즉 설계가 중도 중단된 상태이며, 현재 **127.0.0.1에 바인딩된 bridge-server는 roomId만 알면 같은 Mac의 임의 프로세스가 방에 메시지를 주입할 수 있다.** 실제 위협은 외부 공격이 아니라 **좀비 MCP 프로세스**가 새 방에 잘못 붙거나, 다른 터미널에서 실수로 같은 roomId를 재사용할 때 발생하는 **메시지 교차 오염**이다.

## 목표 / 비목표

### 목표

- Session token을 방마다 발급하고 모든 민감 엔드포인트에서 검증
- **사용자 인터페이스는 완전 불변**: `bridge-codex ENG-1234` / `bridge-claude ENG-1234` 호출 방식 동일 유지
- 기존 token-less PID 파일 포맷(`ENG-1234`만)도 하위호환 (`getRoomAndTokenFromPidFile()`이 이미 지원)
- Tombstone(`bridge-server.ts:96-106`) 로직은 defense-in-depth로 그대로 유지

### 비목표

- 외부 네트워크 공격 방어 (localhost 바인딩으로 이미 충분)
- 악의적 로컬 프로세스 방어 (`ps`로 PID 추적 + `/tmp` 파일 탈취 시나리오는 범위 밖)
- Unix domain socket 전환 / SO_PEERCRED 등 커널 수준 검증
- Web UI / WebSocket / `/api/rooms` 목록 / `/api/health` 인증 (모두 대시보드용 read-only, 사용자 본인 신뢰 범위)

## 위협 모델

**모델 A — 사고 방지용 (Accidental Protection)**

- 대상: 같은 Mac에서 돌아가는 우호적이지만 버그 있는 프로세스
- 대표 시나리오:
  1. 좀비 MCP가 종료되지 않고 살아남아 새로 열린 같은 roomId 방에 잘못 붙음
  2. 수동으로 열어둔 MCP가 방이 닫힌 뒤에도 계속 heartbeat 전송
  3. 실수로 다른 터미널에서 같은 roomId로 두 번 실행
- 토큰 강도: 16 bytes = 32 hex characters (`crypto.randomBytes`)로 충분
- 저장: `/tmp/(claude|codex)-bridge-room-$$` 평문 (기존 파일과 동일 경로)

## 설계

### 토큰 흐름

```
┌─────────────────────────────────────────────────────────┐
│  bridge-codex ENG-1234  (또는 covering-bridge가 spawn)  │
└─────────────────────────────────────────────────────────┘
             │
             │ [1] POST /api/rooms/ENG-1234
             ▼
     ┌───────────────┐
     │ bridge-server │  RoomState.sessionToken 생성·저장
     └───────────────┘
             │
             │ { sessionToken: "ab12…" }  (응답 본문)
             ▼
  wrapper 쪽에서:
     printf "ENG-1234:ab12…" > /tmp/codex-bridge-room-$$
             │
             │ [2] exec codex --full-auto
             ▼
     ┌──────────┐   codex-mcp.ts 기동
     │   MCP    │   getRoomAndTokenFromPidFile() — 이번엔 token retain
     └──────────┘
             │
             │ [3] 모든 fetch에 header: x-bridge-token: ab12…
             ▼
     ┌───────────────┐
     │ bridge-server │  토큰 gate 검증 → 통과 / 401
     └───────────────┘
```

### 3개 수정 지점

#### [1] Wrapper (`bridge-codex`, `bridge-claude`)

```sh
#!/bin/sh
ROOM="${1}"
[ -z "$ROOM" ] && { echo "usage: ..." >&2; exit 1; }

# 신규: 방 생성 & 토큰 획득
RESP=$(curl -s -X POST "http://localhost:8788/api/rooms/$ROOM")
TOKEN=$(echo "$RESP" | grep -o '"sessionToken":"[^"]*"' | cut -d'"' -f4)
[ -z "$TOKEN" ] && { echo "bridge-codex: failed to get token" >&2; exit 1; }

printf "%s:%s" "$ROOM" "$TOKEN" > "/tmp/codex-bridge-room-$$"
exec codex --full-auto
```

- `jq` 같은 외부 의존 없이 `grep` + `cut`으로 JSON 파싱 (Bun / Node 없는 shell 환경 가정)
- 기존 파일 경로 `/tmp/(codex|claude)-bridge-room-$$` 유지
- 포맷: `{roomId}:{token}` (MCP 파서가 이미 지원)

#### [2] MCP (`codex-mcp.ts`, `claude-mcp.ts`)

```ts
// 변경 전
const { roomId: pidFileRoom } = getRoomAndTokenFromPidFile()

// 변경 후
const { roomId: pidFileRoom, token: pidFileToken } = getRoomAndTokenFromPidFile()
const ROOM_ID = process.env.CODEX_BRIDGE_ROOM || pidFileRoom
const BRIDGE_TOKEN = process.env.CODEX_BRIDGE_TOKEN || pidFileToken

// 공통 fetch 헬퍼 추가
const authHeader = BRIDGE_TOKEN ? { 'x-bridge-token': BRIDGE_TOKEN } : {}
function bridgeFetch(path: string, init?: RequestInit) {
  return fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers ?? {}), ...authHeader },
  })
}

// 401/404 처리 통합
// heartbeat / pollLoop / send_to_claude 등에서 응답 status 401 또는 404 확인 시
if (res.status === 401 || res.status === 404) {
  process.stderr.write(`[mcp] auth failed or room gone — exiting\n`)
  process.exit(0)
}
```

- 모든 `fetch(...)` 호출을 `bridgeFetch(...)`로 교체
- 토큰 없으면 헤더 미첨부 → 서버는 legacy 접근으로 판단하고 거부 (또는 마이그레이션 기간 동안 허용, 아래 참조)

#### [3] Server (`bridge-server.ts`)

```ts
import { randomBytes } from 'node:crypto'

type RoomState = {
  // ... 기존 필드들
  sessionToken: string   // 신규: 방 생성 시 1회 발급
}

function getOrCreateRoom(roomId: string): RoomState {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      // ... 기존 필드들
      sessionToken: randomBytes(16).toString('hex'),
    })
  }
  return rooms.get(roomId)!
}

// 검증 헬퍼
function checkToken(req: Request, room: RoomState): Response | null {
  const provided = req.headers.get('x-bridge-token')
  if (!provided || provided !== room.sessionToken) {
    return Response.json({ error: 'bad token' }, { status: 401 })
  }
  return null  // ok
}

// POST /api/rooms/:roomId — 응답에 토큰 포함
if (closeMatch && req.method === 'POST') {
  const roomId = decodeURIComponent(closeMatch[1])
  const room = getOrCreateRoom(roomId)
  return Response.json({ sessionToken: room.sessionToken }, { status: 201 })
}

// 모든 민감 엔드포인트 진입부에서
const authFail = checkToken(req, room)
if (authFail) return authFail
```

### 검증 범위 표

| 엔드포인트 | 메서드 | 토큰 필요? | 사유 |
|---|---|---|---|
| `/api/rooms/:roomId` | POST | ❌ | 토큰 발급 경로 |
| `/api/rooms/:roomId` | DELETE | ❌ | 관리 작업, covering-bridge CLI가 호출. 같은 Mac 신뢰 모델에 포함 (사용자 실수 방지는 CLI 확인 프롬프트가 담당) |
| `/api/rooms/:roomId/claude/connect` | POST/DELETE | ✅ | 연결 위조 방지 |
| `/api/rooms/:roomId/codex/connect` | POST | ✅ | 연결 위조 방지 |
| `/api/rooms/:roomId/codex/heartbeat` | POST | ✅ | heartbeat 위조 방지 |
| `/api/rooms/:roomId/from-codex` | POST | ✅ | 메시지 주입 방지 |
| `/api/rooms/:roomId/from-claude` | POST | ✅ | 메시지 주입 방지 |
| `/api/rooms/:roomId/poll-reply/:id` | GET | ✅ | 답장 탈취 방지 |
| `/api/rooms/:roomId/pending-for-claude` | GET | ✅ | 큐 탈취 방지 |
| `/api/rooms/:roomId/pending-for-codex` | GET | ✅ | 큐 탈취 방지 |
| `/api/rooms` | GET | ❌ | 대시보드 목록, read-only |
| `/api/health` | GET | ❌ | health check |
| `/` | GET | ❌ | Web UI |
| `/ws/:roomId` | WS | ❌ | Web UI real-time (동일 머신 신뢰) |
| `/files/*` | GET | ❌ | 첨부 파일 serving |

### 하위호환 & 롤아웃

- `getRoomAndTokenFromPidFile()`은 이미 token-less 포맷도 처리 (token 빈 문자열 반환)
- **엄격 모드로 바로 간다**: 서버가 발급한 토큰 없이는 민감 엔드포인트 거부. 마이그레이션 유예 기간 없음. 업데이트 한 번에 wrapper + server + MCP를 함께 배포 (동일 repo이므로 원자적 배포 가능)
- 기존에 실행 중이던 MCP 프로세스는 서버 업데이트 직후 401을 받고 `process.exit(0)`로 스스로 종료 → 사용자가 `bridge-codex ENG-1234`를 다시 실행하면 복구

### 에러 처리

| 시나리오 | 동작 |
|---|---|
| Wrapper가 `curl` 실패 (서버 다운) | 에러 메시지 stderr + exit 1 |
| 서버 응답이 JSON 파싱 불가 | 에러 메시지 stderr + exit 1 |
| MCP가 토큰 없이 시작 (`CODEX_BRIDGE_TOKEN` env 없고 PID 파일 없음) | MCP 시작 시 로그 + 서버 요청마다 401 → exit(0) |
| 클라이언트가 토큰 오타 | 서버 401 + `{ error: "bad token" }` |
| 방이 이미 삭제됨 + stale 토큰 재사용 | 서버 404 (room not found) |
| Tombstone 기간 중 재생성 시도 | 서버 404 (기존 로직 유지) |

### 관측성

- 서버: `process.stderr.write('[bridge] auth rejected: roomId=X\n')` 를 토큰 검증 실패 시 찍음
- MCP: `[mcp] auth failed or room gone — exiting` stderr
- 추가 로깅은 P4(메시지 JSONL 히스토리)에서 통합

## 테스트 전략

Step 5 (P2)에서 bridge-server 핵심 경로 테스트 작성 시 통합:

| 케이스 | 기대 |
|---|---|
| `POST /api/rooms/X` → 응답에 `sessionToken` 32자 hex | 통과 |
| 올바른 토큰으로 `/from-codex` | 200 |
| 잘못된 토큰으로 `/from-codex` | 401 |
| 토큰 없이 `/from-codex` | 401 |
| 방 A 토큰으로 방 B의 `/from-codex` 호출 | 401 |
| `DELETE /api/rooms/X` → 새 `POST /api/rooms/X` → 이전 토큰으로 요청 | 401 (새 토큰 발급됨) |
| Wrapper가 생성한 PID 파일 내용 `ENG-1234:abc…` | MCP가 정확히 파싱 |
| `/api/health`, `/api/rooms`, `/` — 토큰 없이도 200 | 통과 |

## 영향 범위 / 변경 파일 요약

| 파일 | 변경량 (예상) |
|---|---|
| `bridge-codex` | +5줄 |
| `bridge-claude` | +5줄 |
| `bridge-server.ts` | +40줄 |
| `codex-mcp.ts` | +10줄, `fetch(...)` 호출부 교체 (~7곳) |
| `claude-mcp.ts` | +10줄, `fetch(...)` 호출부 교체 (~5곳) |
| `README.md` | 수동 경로 설명 단순화 |
| **건드리지 않음** | `covering-bridge.ts`, `room-terminals.ts` (wrapper를 경유하므로) |

## Self-review 체크리스트

- [x] Placeholder/TBD 없음
- [x] 내부 일관성: 흐름 다이어그램 ↔ 3개 수정 지점 ↔ 검증 표 모두 정합
- [x] 범위: 단일 구현 계획으로 수용 가능 (다른 P와 독립적)
- [x] 애매함: "엄격 모드로 바로 간다" 명시하여 유예 기간 해석 차단
- [x] UX 제약 명시: wrapper 호출 인터페이스 불변
- [x] Tombstone과의 상호작용 명시
- [x] 토큰 없이도 접근 가능한 엔드포인트 명시 (WebSocket 포함)
