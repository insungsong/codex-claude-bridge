# Multi-Room Codex-Claude Bridge — Design Spec

**Date:** 2026-04-12  
**Status:** Approved  
**Repo:** fork of `github.com/abhishekgahlot2/codex-claude-bridge`

---

## 목적

티켓 단위로 여러 Codex ↔ Claude 쌍을 동시에 운영할 수 있는 멀티룸 브리지.  
각 룸은 티켓 번호(예: `ENG-1234`)로 식별되며, 독립된 메시지 채널을 가진다.

예시:
```
Room ENG-1234: Codex-A ↔ Claude-A  (feature A 개발 중)
Room ENG-5678: Codex-B ↔ Claude-B  (feature B 개발 중)
Room ENG-9999: Codex-C ↔ Claude-C  (feature C 개발 중)
```

---

## 아키텍처

### 파일 구조

```
codex-claude-bridge/
├── bridge-server.ts      NEW  중앙 HTTP 서버 (룸 라우팅)
├── claude-mcp.ts         NEW  Claude측 MCP relay (룸 인식)
├── codex-mcp.ts          MOD  Codex측 MCP (roomId 추가)
├── covering-bridge.ts    NEW  룸 매니저 CLI
└── package.json          MOD  새 스크립트 추가
```

기존 `server.ts`는 `claude-mcp.ts`로 분리된다:
- HTTP 서버 로직 → `bridge-server.ts`
- Claude MCP relay → `claude-mcp.ts`

### 컴포넌트 역할

**bridge-server.ts** (단일 프로세스, port 8788)
- 모든 룸의 중앙 HTTP 허브
- `rooms: Map<roomId, RoomState>` 로 룸별 상태 격리
- 룸은 명시적 종료(DELETE /api/rooms/:roomId) 전까지 유지

**claude-mcp.ts** (룸당 1개 인스턴스)
- `CODEX_BRIDGE_ROOM=ENG-1234` 환경변수로 룸 식별
- 백그라운드 폴링 루프 → bridge-server에서 Codex 메시지 수신
- `mcp.notification()`으로 Claude에게 push
- `reply`, `send_to_codex`, `edit_message` 툴 → bridge-server로 포워딩

**codex-mcp.ts** (룸당 1개 인스턴스)
- `CODEX_BRIDGE_ROOM=ENG-1234` 환경변수로 룸 식별
- 모든 API 요청에 roomId 포함

**covering-bridge.ts** (CLI 툴)
- bridge-server 자동 시작
- 룸 목록 조회 및 표시
- 새 룸 개설 (티켓 번호 입력)
- 터미널 자동 오픈 (tmux / iTerm2 / 수동)
- 룸 명시적 종료

---

## 데이터 모델

```typescript
type RoomState = {
  id: string                                      // "ENG-1234"
  createdAt: number
  claudeConnected: boolean
  codexConnected: boolean
  lastActivity: number
  pendingReplies: Map<string, PendingReply>        // Codex 답변 대기
  inFlightCodexMessages: Map<string, string>       // 중복 방지
  pendingForCodex: { id: string; text: string }[]  // Claude→Codex 큐
  pendingForClaude: { id: string; text: string; sender: string }[] // Codex→Claude 큐
}

const rooms = new Map<string, RoomState>()
```

---

## API 설계

### bridge-server.ts HTTP Endpoints

```
POST   /api/rooms/:roomId/from-codex          Codex → Claude 메시지 전송
GET    /api/rooms/:roomId/poll-reply/:id      Codex가 Claude 응답 폴링 (long-poll)
GET    /api/rooms/:roomId/pending-for-codex   Claude가 먼저 보낸 메시지 확인
GET    /api/rooms/:roomId/pending-for-claude  claude-mcp.ts 폴링용 (신규)
POST   /api/rooms/:roomId/from-claude         claude-mcp.ts → 중앙 서버 응답 전달 (신규)
GET    /api/rooms                             룸 목록 (covering-bridge용)
DELETE /api/rooms/:roomId                     룸 명시적 종료
GET    /api/health                            헬스체크
WebSocket /ws/:roomId                         Web UI 실시간 연결
```

### 에러 처리

| 상황 | 응답 |
|------|------|
| 존재하지 않는 roomId | 404 `{ error: "room not found" }` |
| Claude 미연결 시 Codex 메시지 | 룸 생성 후 pendingForClaude에 버퍼링 |
| 같은 티켓으로 중복 룸 생성 | 기존 룸 상태 반환 + 경고 |
| bridge-server 미실행 | covering-bridge가 자동 시작 시도 |

### 룸 생명주기

```
created → claude_connected → both_connected → active → [명시적 종료]
```

자동 만료 없음. `DELETE /api/rooms/:roomId` 또는 covering-bridge CLI의 close 커맨드로만 종료.

---

## 메시지 플로우

### Codex → Claude

```
codex-mcp.ts
  → POST /api/rooms/ENG-1234/from-codex
  → bridge-server: pendingForClaude에 저장
  → claude-mcp.ts 폴링 감지
  → mcp.notification() → Claude
  → Claude: reply 툴 호출
  → claude-mcp.ts: POST /api/rooms/ENG-1234/from-claude
  → bridge-server: pending waiter resolve
  → codex-mcp.ts: long-poll 응답 수신
```

### Claude → Codex (선제적)

```
Claude: send_to_codex 툴 호출
  → claude-mcp.ts: POST /api/rooms/ENG-1234/from-claude (proactive=true)
  → bridge-server: pendingForCodex에 저장
  → codex-mcp.ts: GET /api/rooms/ENG-1234/pending-for-codex
```

---

## covering-bridge CLI UX

```
$ covering-bridge

╔══════════════════════════════════════╗
║  Codex-Claude Bridge  •  Rooms       ║
╚══════════════════════════════════════╝

  ENG-1234   claude ✓  codex ✓   12m ago
  ENG-5678   claude ✓  codex ✗    3m ago

[o] open new room   [c] close room   [q] quit

Open new room — ticket number: ENG-9999

→ Opening room ENG-9999...
✓ Done. Two terminal panes opened.
```

### 터미널 오픈 전략 (우선순위)

1. **tmux** (`$TMUX` 환경변수 감지) → `tmux new-window` + `split-window -h`
2. **iTerm2** (`$TERM_PROGRAM === 'iTerm.app'`) → AppleScript 새 탭
3. **Fallback** → 명령어 출력, 사용자가 직접 실행

실행 커맨드:
```bash
CODEX_BRIDGE_ROOM=ENG-9999 claude --dangerously-load-development-channels
CODEX_BRIDGE_ROOM=ENG-9999 codex --full-auto
```

---

## package.json 스크립트

```json
{
  "scripts": {
    "server": "bun bridge-server.ts",
    "bridge": "bun covering-bridge.ts",
    "claude-mcp": "bun claude-mcp.ts",
    "codex-mcp": "bun codex-mcp.ts"
  }
}
```

---

## 구현 순서

1. `bridge-server.ts` — 룸 라우팅 HTTP 서버
2. `claude-mcp.ts` — Claude MCP relay (폴링 루프 포함)
3. `codex-mcp.ts` — roomId 지원 추가
4. `covering-bridge.ts` — CLI 룸 매니저
5. `package.json` 업데이트

---

## 미결 사항

없음.
