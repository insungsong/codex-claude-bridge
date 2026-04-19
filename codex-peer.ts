#!/usr/bin/env bun
/**
 * Codex Bridge — app-server-backed Codex peer bridge.
 *
 * For codex-backed rooms, this process is the real bridge adapter:
 * - launches a peer `codex app-server`
 * - waits for the peer Codex UI to create and own a thread on that server
 * - injects bridge messages into that thread with `turn/start`
 * - forwards the peer Codex's final reply back through `/from-claude`
 *
 * The foreground `codex --remote ...` session owns the same thread that the
 * bridge uses, so the user can observe the real peer turns in the Codex UI.
 */

import { existsSync, readFileSync, unlinkSync, writeFileSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'

import { validateBridgeTextPayload } from './bridge-message-payload'
import { DEFAULT_REPLY_WAIT_POLICY } from './reply-wait-policy'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const CODEX_BIN = process.env.CODEX_BRIDGE_CODEX_BIN ?? 'codex'
const WORKDIR = process.env.CODEX_BRIDGE_WORKDIR ?? process.cwd()
const POLL_TIMEOUT_MS = 30_000
const POLL_BACKOFF_MS = 1_000
const HEARTBEAT_INTERVAL_MS = 1_000
const APP_SERVER_HOST = '127.0.0.1'
const APP_SERVER_BASE_PORT = Number(process.env.CODEX_BRIDGE_PEER_BASE_PORT ?? 4510)
const APP_SERVER_PORT_SPAN = Number(process.env.CODEX_BRIDGE_PEER_PORT_SPAN ?? 200)
const APP_SERVER_START_TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_PEER_START_TIMEOUT_MS ?? 10_000)
const APP_SERVER_LOG_FILE = process.env.CODEX_BRIDGE_PEER_LOG_FILE
  ?? join('/tmp', `codex-peer-app-server-${process.env.CODEX_BRIDGE_ROOM ?? 'unknown'}.log`)
const LAUNCH_FILE = process.env.CODEX_BRIDGE_LAUNCH_FILE
const PID_FILE = process.env.CODEX_BRIDGE_PID_FILE
const PARENT_PID = Number(process.env.CODEX_BRIDGE_PARENT_PID ?? '')
const APP_SERVER_READY_POLL_MS = 200
const THREAD_PATH_WAIT_TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_THREAD_PATH_WAIT_TIMEOUT_MS ?? 10_000)
const THREAD_READ_POLL_MS = Number(process.env.CODEX_BRIDGE_THREAD_READ_POLL_MS ?? 1000)
const BRIDGE_TURN_TIMEOUT_MS = Number(process.env.CODEX_BRIDGE_TURN_TIMEOUT_MS ?? DEFAULT_REPLY_WAIT_POLICY.maxWaitMs)
const BRIDGE_PROGRESS_HEARTBEAT_MS = Number(process.env.CODEX_BRIDGE_PROGRESS_HEARTBEAT_MS ?? 15_000)
const PEER_CONFIG_OVERRIDES = [
  '-c', 'features.codex_hooks=false',
  '-c', 'mcp_servers.context7.enabled=false',
  '-c', 'mcp_servers.linear.enabled=false',
  '-c', 'mcp_servers.github.enabled=false',
  '-c', 'mcp_servers.openaiDeveloper.enabled=false',
  '-c', 'mcp_servers.insomnia.enabled=false',
  '-c', 'mcp_servers.codex-bridge.enabled=false',
  '-c', 'mcp_servers.omx_state.enabled=false',
  '-c', 'mcp_servers.omx_memory.enabled=false',
  '-c', 'mcp_servers.omx_code_intel.enabled=false',
  '-c', 'mcp_servers.omx_trace.enabled=false',
] as const

type MessagePhase = 'commentary' | 'final_answer' | null

type AppServerRequest = {
  id: number
  method: string
  params: unknown
}

type AppServerResponse = {
  id: number
  result?: unknown
  error?: {
    code?: number
    message?: string
  }
}

type AppServerNotification = {
  method: string
  params?: Record<string, unknown>
}

type BridgeMessage = {
  id: string
  text: string
  sender: string
}

type InitializeRequest = {
  id: number
  method: 'initialize'
  params: {
    clientInfo: {
      name: string
      title: null
      version: string
    }
    capabilities: {
      experimentalApi: true
    }
  }
}

type TurnStartRequest = {
  id: number
  method: 'turn/start'
  params: {
    threadId: string
    input: Array<{
      type: 'text'
      text: string
      text_elements: []
    }>
  }
}

type ThreadResumeRequest = {
  id: number
  method: 'thread/resume'
  params: {
    threadId: string
    path?: string
    persistExtendedHistory: false
  }
}

type CompletedAgentMessage = {
  type: 'agentMessage'
  text: string
  phase: MessagePhase
}

type CompletedTurnItem =
  | CompletedAgentMessage
  | {
      type: string
      aggregatedOutput?: string | null
    }

type TrackedTurn = {
  source: 'bridge' | 'peer' | 'unknown'
  bridgeMessageId?: string
  items: CompletedTurnItem[]
  resolved: boolean
  waiters: Array<(reply: string | null) => void>
}

export function buildCodexRemoteLaunchArgs(options: {
  wsUrl: string
  roomId: string
}) {
  return [
    '--remote', options.wsUrl,
    ...PEER_CONFIG_OVERRIDES,
    '-m', process.env.CODEX_BRIDGE_PEER_MODEL ?? 'gpt-5.4',
    `Bridge peer online for room ${options.roomId}. Briefly acknowledge readiness, then wait for further requests from this thread.`,
  ]
}

export function buildCodexAppServerArgs(options: {
  wsUrl: string
  workingDirectory: string
}) {
  return [
    '-C', options.workingDirectory,
    ...PEER_CONFIG_OVERRIDES,
    'app-server',
    '--listen', options.wsUrl,
  ]
}

export function buildInitializeRequest(id: number): InitializeRequest {
  return {
    id,
    method: 'initialize',
    params: {
      clientInfo: {
        name: 'codex-bridge',
        title: null,
        version: '0.4.0',
      },
      capabilities: {
        experimentalApi: true,
      },
    },
  }
}

export function buildTurnStartRequest(options: {
  id: number
  threadId: string
  message: string
}): TurnStartRequest {
  return {
    id: options.id,
    method: 'turn/start',
    params: {
      threadId: options.threadId,
      input: [{
        type: 'text',
        text: options.message,
        text_elements: [],
      }],
    },
  }
}

export function buildThreadResumeRequest(options: {
  id: number
  threadId: string
  path?: string
}): ThreadResumeRequest {
  return {
    id: options.id,
    method: 'thread/resume',
    params: {
      threadId: options.threadId,
      ...(options.path ? { path: options.path } : {}),
      persistExtendedHistory: false,
    },
  }
}

export function selectTurnReply(items: CompletedTurnItem[]) {
  const finalAnswer = [...items]
    .reverse()
    .find(item => item.type === 'agentMessage' && item.phase === 'final_answer')
  if (finalAnswer && finalAnswer.type === 'agentMessage' && finalAnswer.text.trim()) {
    return finalAnswer.text
  }

  const latestAgentMessage = [...items]
    .reverse()
    .find(item => item.type === 'agentMessage' && item.text.trim())
  if (latestAgentMessage && latestAgentMessage.type === 'agentMessage') {
    return latestAgentMessage.text
  }

  return null
}

function logPeer(message: string) {
  const line = `[codex-peer] ${message}\n`
  try {
    appendFileSync(APP_SERVER_LOG_FILE, line, 'utf8')
  } catch {}
  process.stderr.write(line)
}

function getRoomAndTokenFromPidFile(): { roomId: string; token: string } {
  try {
    const content = readFileSync(`/tmp/codex-peer-bridge-room-${process.pid}`, 'utf8').trim()
    const idx = content.indexOf(':')
    if (idx === -1) return { roomId: content, token: '' }
    return { roomId: content.slice(0, idx), token: content.slice(idx + 1) }
  } catch {
    return { roomId: '', token: '' }
  }
}

const { roomId: pidFileRoom, token: pidFileToken } = getRoomAndTokenFromPidFile()

type RuntimeConfig = {
  roomId: string
  bridgeToken: string
  base: string
  authHeaders: { 'x-bridge-token': string }
}

function getRuntimeConfig(): RuntimeConfig {
  const roomId = process.env.CODEX_BRIDGE_ROOM || pidFileRoom
  const bridgeToken = process.env.CODEX_BRIDGE_TOKEN || pidFileToken

  if (!roomId) {
    process.stderr.write('codex-peer: room not found — set CODEX_BRIDGE_ROOM or use bridge-codex-peer\n')
    process.exit(1)
  }

  if (!bridgeToken) {
    process.stderr.write('codex-peer: session token not found — use bridge-codex-peer or set CODEX_BRIDGE_TOKEN\n')
    process.exit(1)
  }

  return {
    roomId,
    bridgeToken,
    base: `${BRIDGE_URL}/api/rooms/${encodeURIComponent(roomId)}`,
    authHeaders: { 'x-bridge-token': bridgeToken },
  }
}

function mergeHeaders(base?: HeadersInit, authHeaders?: { 'x-bridge-token': string }): Record<string, string> {
  const tokenHeaders = authHeaders ?? { 'x-bridge-token': '' }
  if (!base) return { ...tokenHeaders }
  if (base instanceof Headers) {
    const out: Record<string, string> = {}
    base.forEach((value, key) => { out[key] = value })
    return { ...out, ...tokenHeaders }
  }
  if (Array.isArray(base)) return { ...Object.fromEntries(base), ...tokenHeaders }
  return { ...(base as Record<string, string>), ...tokenHeaders }
}

function createBridgeFetch(config: RuntimeConfig) {
  return async function bridgeFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${config.base}${path}`, {
      ...init,
      headers: mergeHeaders(init?.headers, config.authHeaders),
    })
  }
}

function failAuth(status: number, where: string): never {
  logPeer(`${where} returned ${status} — exiting`)
  process.exit(0)
}

function exitOnAuthFail(status: number, where: string): void {
  if (status === 401 || status === 404) failAuth(status, where)
}

class JsonRpcWebSocketClient {
  private ws: WebSocket | null = null
  private nextId = 1
  private pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  private notificationHandlers = new Set<(notification: AppServerNotification) => void>()

  async connect(wsUrl: string) {
    await new Promise<void>((resolve, reject) => {
      const ws = new WebSocket(wsUrl)
      this.ws = ws

      const timeout = setTimeout(() => {
        try { ws.close() } catch {}
        reject(new Error(`timed out connecting to ${wsUrl}`))
      }, APP_SERVER_START_TIMEOUT_MS)

      ws.onopen = () => {
        clearTimeout(timeout)
        resolve()
      }

      ws.onerror = event => {
        clearTimeout(timeout)
        reject(new Error(`websocket error: ${String((event as Event).type)}`))
      }

      ws.onclose = () => {
        clearTimeout(timeout)
        const error = new Error('app-server websocket closed')
        for (const pending of this.pending.values()) pending.reject(error)
        this.pending.clear()
      }

      ws.onmessage = event => {
        const raw = typeof event.data === 'string' ? event.data : String(event.data)
        const payload = JSON.parse(raw) as AppServerResponse | AppServerNotification

        if ('id' in payload && payload.id !== undefined) {
          const pending = this.pending.get(Number(payload.id))
          if (!pending) return
          this.pending.delete(Number(payload.id))
          if ('error' in payload && payload.error) {
            pending.reject(new Error(payload.error.message ?? `app-server error ${payload.error.code ?? 'unknown'}`))
            return
          }
          pending.resolve(payload.result)
          return
        }

        if ('method' in payload) {
          for (const handler of this.notificationHandlers) handler(payload)
        }
      }
    })
  }

  async request<T>(method: string, params: unknown): Promise<T> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('app-server websocket is not open')
    }

    const id = this.nextId++
    const request: AppServerRequest = { id, method, params }
    const response = new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
    })
    this.ws.send(JSON.stringify(request))
    return await response as T
  }

  onNotification(handler: (notification: AppServerNotification) => void) {
    this.notificationHandlers.add(handler)
  }

  close() {
    try { this.ws?.close() } catch {}
  }
}

class CodexPeerBridge {
  private rpc = new JsonRpcWebSocketClient()
  private appServerProc: Bun.Subprocess | null = null
  private wsUrl = ''
  private threadId = ''
  private threadPath = ''
  private threadBusy = false
  private bridgeQueue: BridgeMessage[] = []
  private bridgeProcessing = false
  private trackedTurns = new Map<string, TrackedTurn>()
  private bridgeStartedTurns = new Set<string>()
  private proactiveForwardedTurns = new Set<string>()

  constructor(
    private readonly config: RuntimeConfig,
    private readonly bridgeFetchFn: (path: string, init?: RequestInit) => Promise<Response>,
  ) {}

  async start() {
    await this.startAppServer()
    await this.rpc.connect(this.wsUrl)
    this.rpc.onNotification(notification => {
      void this.handleNotification(notification)
    })

    await this.rpc.request('initialize', buildInitializeRequest(1).params)
    this.writeLaunchFile()
  }

  private writeLaunchFile() {
    if (!LAUNCH_FILE) return
    writeFileSync(LAUNCH_FILE, `WS_URL=${this.wsUrl}\nTHREAD_ID=${this.threadId}\n`, 'utf8')
  }

  private async startAppServer() {
    const offset = this.hashRoomId(this.config.roomId) % APP_SERVER_PORT_SPAN

    for (let i = 0; i < APP_SERVER_PORT_SPAN; i++) {
      const port = APP_SERVER_BASE_PORT + ((offset + i) % APP_SERVER_PORT_SPAN)
      const candidateUrl = `ws://${APP_SERVER_HOST}:${port}`
      const readyUrl = `http://${APP_SERVER_HOST}:${port}/readyz`
      const args = buildCodexAppServerArgs({
        wsUrl: candidateUrl,
        workingDirectory: WORKDIR,
      })
      const proc = Bun.spawn([CODEX_BIN, ...args], {
        cwd: WORKDIR,
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      })

      try {
        await this.waitForAppServerReady(readyUrl)
        this.appServerProc = proc
        this.wsUrl = candidateUrl
        logPeer(`peer app-server listening on ${candidateUrl}`)
        return
      } catch {
        try { proc.kill() } catch {}
        await proc.exited.catch(() => {})
      }
    }

    throw new Error('failed to start a peer codex app-server')
  }

  private async waitForAppServerReady(readyUrl: string) {
    const deadline = Date.now() + APP_SERVER_START_TIMEOUT_MS
    while (Date.now() < deadline) {
      try {
        const res = await fetch(readyUrl, { signal: AbortSignal.timeout(500) })
        if (res.ok) return
      } catch {}
      await Bun.sleep(APP_SERVER_READY_POLL_MS)
    }
    throw new Error(`timed out waiting for peer app-server readyz at ${readyUrl}`)
  }

  private hashRoomId(roomId: string) {
    let hash = 0
    for (const ch of roomId) hash = (hash * 33 + ch.charCodeAt(0)) >>> 0
    return hash
  }

  private getOrCreateTrackedTurn(turnId: string) {
    const existing = this.trackedTurns.get(turnId)
    if (existing) return existing

    const created: TrackedTurn = {
      source: 'unknown',
      items: [],
      resolved: false,
      waiters: [],
    }
    this.trackedTurns.set(turnId, created)
    return created
  }

  private waitForTurnCompletion(turnId: string) {
    return new Promise<string | null>(resolve => {
      const tracked = this.getOrCreateTrackedTurn(turnId)
      tracked.waiters.push(resolve)
    })
  }

  private resolveTrackedTurn(turnId: string, reply: string | null) {
    const tracked = this.trackedTurns.get(turnId)
    if (!tracked || tracked.resolved) return
    tracked.resolved = true
    for (const waiter of tracked.waiters) waiter(reply)
    tracked.waiters = []
  }

  private async handleNotification(notification: AppServerNotification) {
    switch (notification.method) {
      case 'thread/started': {
        const threadId = String(notification.params?.thread?.id ?? '')
        const threadPath = String(notification.params?.thread?.path ?? '')
        if (!threadId) return
        if (!this.threadId) {
          this.threadId = threadId
          this.threadPath = threadPath
          this.writeLaunchFile()
          logPeer(`adopted peer-owned thread ${threadId}`)
          void this.processBridgeQueue()
        }
        return
      }

      case 'thread/status/changed': {
        const threadId = String(notification.params?.threadId ?? '')
        if (this.threadId && threadId && threadId !== this.threadId) return
        const status = notification.params?.status as { type?: string } | undefined
        this.threadBusy = status?.type === 'active'
        if (!this.threadBusy) void this.processBridgeQueue()
        return
      }

      case 'turn/started': {
        const turnId = String(notification.params?.turn?.id ?? '')
        if (!turnId) return
        this.getOrCreateTrackedTurn(turnId)
        return
      }

      case 'item/completed': {
        const turnId = String(notification.params?.turnId ?? '')
        const tracked = turnId ? this.getOrCreateTrackedTurn(turnId) : null
        const item = notification.params?.item as { type?: string; text?: string; phase?: MessagePhase } | undefined
        if (!tracked || !item?.type) return
        if (item.type === 'agentMessage') {
          tracked.items.push({
            type: 'agentMessage',
            text: item.text ?? '',
            phase: item.phase ?? null,
          })
        } else {
          tracked.items.push({ type: item.type })
        }
        return
      }

      case 'item/agentMessage/delta': {
        const turnId = String(notification.params?.turnId ?? '')
        if (!turnId || !this.bridgeStartedTurns.has(turnId)) return
        const tracked = this.trackedTurns.get(turnId)
        if (!tracked?.bridgeMessageId) return
        await this.markInProgress(tracked.bridgeMessageId, 'Codex peer is generating a reply')
        return
      }

      case 'turn/completed': {
        const turn = notification.params?.turn as { id?: string } | undefined
        const turnId = String(turn?.id ?? '')
        if (!turnId) return

        const tracked = this.getOrCreateTrackedTurn(turnId)
        const reply = selectTurnReply(tracked.items)

        if (tracked.source === 'bridge') {
          this.resolveTrackedTurn(turnId, reply)
          return
        }

        if (!this.proactiveForwardedTurns.has(turnId) && reply?.trim()) {
          this.proactiveForwardedTurns.add(turnId)
          await this.sendProactive(reply)
        }
        return
      }

      case 'thread/closed': {
        const threadId = String(notification.params?.threadId ?? '')
        if (threadId && threadId === this.threadId) {
          this.threadId = ''
          this.threadPath = ''
          this.threadBusy = false
          this.writeLaunchFile()
          logPeer(`peer thread ${threadId} closed`)
        }
        return
      }

      default:
        return
    }
  }

  async enqueueBridgeMessages(messages: BridgeMessage[]) {
    this.bridgeQueue.push(...messages)
    await this.processBridgeQueue()
  }

  private async processBridgeQueue() {
    if (this.bridgeProcessing || this.threadBusy || this.bridgeQueue.length === 0 || !this.threadId) return
    this.bridgeProcessing = true

    while (this.bridgeQueue.length > 0) {
      if (this.threadBusy) break
      const message = this.bridgeQueue.shift()
      if (!message) continue
      await this.handleBridgeMessage(message)
    }

    this.bridgeProcessing = false
  }

  private async handleBridgeMessage(message: BridgeMessage) {
    const validation = validateBridgeTextPayload(message.text)
    if (!validation.ok) {
      await this.sendReply(message.id, `Codex peer rejected the message: ${validation.error}`)
      return
    }

    await this.markInProgress(message.id, 'Dispatching request to peer Codex')
    const response = await this.rpc.request<{ turn: { id: string } }>(
      'turn/start',
      buildTurnStartRequest({
        id: 3,
        threadId: this.threadId,
        message: validation.text,
      }).params,
    )
    const turnId = response.turn.id
    this.bridgeStartedTurns.add(turnId)

    const tracked = this.getOrCreateTrackedTurn(turnId)
    tracked.source = 'bridge'
    tracked.bridgeMessageId = message.id

    const reply = await this.waitForBridgeTurnReply(turnId)
    this.bridgeStartedTurns.delete(turnId)

    await this.sendReply(
      message.id,
      reply?.trim() ? reply : 'Codex peer completed the turn without a final answer.',
    )
  }

  async run() {
    await this.start()
    await this.heartbeat()
    setInterval(() => { void this.heartbeat() }, HEARTBEAT_INTERVAL_MS)
    setInterval(() => {
      if (Number.isInteger(PARENT_PID) && PARENT_PID > 0) {
        try {
          process.kill(PARENT_PID, 0)
        } catch {
          process.exit(0)
        }
      }
    }, 1000)

    logPeer(`bridging room ${this.config.roomId} through ${this.wsUrl}; waiting for peer-owned thread`)

    while (true) {
      try {
        const res = await this.bridgeFetch(
          `/pending-for-claude?timeout=${POLL_TIMEOUT_MS}`,
          { signal: AbortSignal.timeout(POLL_TIMEOUT_MS + 5000) },
        )
        exitOnAuthFail(res.status, 'pending-for-claude')
        if (!res.ok) {
          await Bun.sleep(POLL_BACKOFF_MS)
          continue
        }

        const { messages } = await res.json() as { messages: BridgeMessage[] }
        if (messages.length > 0) {
          await this.enqueueBridgeMessages(messages)
        }
      } catch {
        await Bun.sleep(POLL_BACKOFF_MS)
      }
    }
  }

  private async heartbeat() {
    try {
      const res = await this.bridgeFetch(
        '/claude/connect',
        { method: 'POST', signal: AbortSignal.timeout(5000) },
      )
      if (res.status === 401 || res.status === 404) {
        logPeer(`room ${this.config.roomId} closed — exiting`)
        process.exit(0)
      }
    } catch {}
  }

  private async markInProgress(bridgeMessageId: string, note: string) {
    try {
      const res = await this.bridgeFetch(`/reply-progress/${encodeURIComponent(bridgeMessageId)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ note }),
      })
      exitOnAuthFail(res.status, 'reply-progress')
    } catch {}
  }

  private async sendReply(replyTo: string, text: string) {
    const res = await this.bridgeFetch('/from-claude', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, replyTo, proactive: false }),
    })
    exitOnAuthFail(res.status, 'from-claude')
    if (!res.ok) throw new Error(`bridge reply error: ${res.status}`)
  }

  private async sendProactive(text: string) {
    const res = await this.bridgeFetch('/from-claude', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text, proactive: true }),
    })
    exitOnAuthFail(res.status, 'from-claude')
  }

  private bridgeFetch(path: string, init?: RequestInit) {
    return this.bridgeFetchFn(path, init)
  }

  private async waitForThreadPath() {
    if (!this.threadPath) return
    const deadline = Date.now() + THREAD_PATH_WAIT_TIMEOUT_MS
    while (Date.now() < deadline) {
      if (existsSync(this.threadPath)) return
      await Bun.sleep(100)
    }
    throw new Error(`timed out waiting for peer thread rollout at ${this.threadPath}`)
  }

  private async waitForBridgeTurnReply(turnId: string) {
    const deadline = Date.now() + BRIDGE_TURN_TIMEOUT_MS
    let lastHeartbeatAt = 0
    while (Date.now() < deadline) {
      const turn = await this.readTurn(turnId)
      if (!turn) {
        const tracked = this.trackedTurns.get(turnId)
        if (tracked?.bridgeMessageId && Date.now() - lastHeartbeatAt >= BRIDGE_PROGRESS_HEARTBEAT_MS) {
          lastHeartbeatAt = Date.now()
          await this.markInProgress(tracked.bridgeMessageId, 'Codex peer is still thinking')
        }
        await Bun.sleep(THREAD_READ_POLL_MS)
        continue
      }

      const tracked = this.getOrCreateTrackedTurn(turnId)
      tracked.items = turn.items

      if (turn.status === 'completed') {
        const reply = selectTurnReply(turn.items)
        this.resolveTrackedTurn(turnId, reply)
        return reply
      }

      if (tracked.bridgeMessageId && Date.now() - lastHeartbeatAt >= BRIDGE_PROGRESS_HEARTBEAT_MS) {
        lastHeartbeatAt = Date.now()
        await this.markInProgress(tracked.bridgeMessageId, 'Codex peer is still thinking')
      }

      await Bun.sleep(THREAD_READ_POLL_MS)
    }

    return null
  }

  private async readTurn(turnId: string) {
    try {
      const read = await this.rpc.request<{ thread: { turns: Array<{ id: string; items: CompletedTurnItem[]; status: string }> } }>(
        'thread/read',
        {
          threadId: this.threadId,
          includeTurns: true,
        },
      )
      return read.thread.turns.find(turn => turn.id === turnId) ?? null
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (
        message.includes('not materialized yet') ||
        message.includes('includeTurns is unavailable')
      ) {
        return null
      }
      throw error
    }
  }

  async close() {
    this.rpc.close()
    try {
      await this.bridgeFetch('/claude/connect', { method: 'DELETE', signal: AbortSignal.timeout(3000) })
    } catch {}

    if (LAUNCH_FILE) {
      try { unlinkSync(LAUNCH_FILE) } catch {}
    }
    if (PID_FILE) {
      try { unlinkSync(PID_FILE) } catch {}
    }

    if (this.appServerProc) {
      try { this.appServerProc.kill() } catch {}
      await this.appServerProc.exited.catch(() => {})
    }
  }
}

if (import.meta.main) {
  const runtimeConfig = getRuntimeConfig()
  const bridge = new CodexPeerBridge(
    runtimeConfig,
    createBridgeFetch(runtimeConfig),
  )

  process.on('exit', () => { void bridge.close() })
  process.on('SIGINT', () => { void bridge.close().finally(() => process.exit(0)) })
  process.on('SIGTERM', () => { void bridge.close().finally(() => process.exit(0)) })

  await bridge.run()
}
