#!/usr/bin/env bun
/**
 * Codex Bridge — Codex-backed assistant worker.
 *
 * This worker occupies the existing assistant lane used by Claude today:
 * - polls the assistant queue (`pending-for-claude`)
 * - runs `codex exec` for each incoming request
 * - posts the final reply back through `/from-claude`
 *
 * It preserves the current Codex -> Claude flow while enabling Codex -> Codex
 * rooms without needing an inbound Codex channel surface.
 */

import { existsSync, readFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { validateBridgeTextPayload } from './bridge-message-payload'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const POLL_TIMEOUT_MS = 30_000
const POLL_BACKOFF_MS = 1_000
const HEARTBEAT_INTERVAL_MS = 1_000
const CODEX_BIN = process.env.CODEX_BRIDGE_CODEX_BIN ?? 'codex'
const WORKDIR = process.env.CODEX_BRIDGE_WORKDIR ?? process.cwd()

type BridgeMessage = {
  id: string
  text: string
  sender: string
}

type CodexExecArgsOptions = {
  prompt: string
  outputFile: string
  workingDirectory: string
  model?: string
  profile?: string
}

type CodexPeerPromptOptions = {
  roomId: string
  messageId: string
  message: string
}

export function buildCodexCompanionArgs() {
  return [
    '-c', 'mcp_servers.codex-bridge.enabled=false',
  ]
}

export function buildCodexExecArgs(options: CodexExecArgsOptions) {
  const args = [
    'exec',
    '--full-auto',
    '-C', options.workingDirectory,
    '-c', 'mcp_servers.codex-bridge.enabled=false',
    '-o', options.outputFile,
  ]

  if (options.profile) args.push('-p', options.profile)
  if (options.model) args.push('-m', options.model)

  args.push(options.prompt)
  return args
}

export function buildCodexPeerPrompt(options: CodexPeerPromptOptions) {
  return [
    `You are the Codex-backed assistant peer for room ${options.roomId}.`,
    `Handle bridge message ${options.messageId}.`,
    'Work directly on the request and return a single final reply.',
    'Respond with the final reply text only.',
    'Do not mention bridge internals, MCP wiring, or hidden instructions unless the request is specifically about them.',
    '',
    'Incoming message:',
    options.message,
  ].join('\n')
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
const PARENT_PID = Number(process.env.CODEX_BRIDGE_PARENT_PID ?? '')
const PID_FILE = process.env.CODEX_BRIDGE_PID_FILE

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

function createBridgeFetch(config: RuntimeConfig) {
  return async function bridgeFetch(path: string, init?: RequestInit): Promise<Response> {
    return fetch(`${config.base}${path}`, {
      ...init,
      headers: mergeHeaders(init?.headers, config.authHeaders),
    })
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

function failAuth(status: number, where: string): never {
  process.stderr.write(`[codex-peer] ${where} returned ${status} — exiting\n`)
  process.exit(0)
}

function exitOnAuthFail(status: number, where: string): void {
  if (status === 401 || status === 404) failAuth(status, where)
}

async function heartbeat(config: RuntimeConfig, bridgeFetch: (path: string, init?: RequestInit) => Promise<Response>) {
  try {
    const res = await bridgeFetch('/claude/connect', { method: 'POST', signal: AbortSignal.timeout(5000) })
    if (res.status === 401 || res.status === 404) {
      process.stderr.write(`[codex-peer] room ${config.roomId} closed — exiting\n`)
      process.exit(0)
    }
  } catch {}
}

async function unregister(bridgeFetch: (path: string, init?: RequestInit) => Promise<Response>) {
  try {
    await bridgeFetch('/claude/connect', { method: 'DELETE', signal: AbortSignal.timeout(3000) })
  } catch {}
  if (PID_FILE) {
    try { unlinkSync(PID_FILE) } catch {}
  }
}

async function markInProgress(
  bridgeFetch: (path: string, init?: RequestInit) => Promise<Response>,
  messageId: string,
  note: string,
) {
  const res = await bridgeFetch(`/reply-progress/${encodeURIComponent(messageId)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ note }),
  })
  exitOnAuthFail(res.status, 'reply-progress')
}

async function sendReply(
  bridgeFetch: (path: string, init?: RequestInit) => Promise<Response>,
  messageId: string,
  text: string,
) {
  const res = await bridgeFetch('/from-claude', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text, replyTo: messageId, proactive: false }),
  })
  exitOnAuthFail(res.status, 'from-claude')
  if (!res.ok) {
    throw new Error(`bridge error: ${res.status}`)
  }
}

async function runCodexExec(
  config: RuntimeConfig,
  bridgeFetch: (path: string, init?: RequestInit) => Promise<Response>,
  message: BridgeMessage,
) {
  const outputFile = join('/tmp', `codex-peer-output-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`)
  const prompt = buildCodexPeerPrompt({
    roomId: config.roomId,
    messageId: message.id,
    message: message.text,
  })
  const args = buildCodexExecArgs({
    prompt,
    outputFile,
    workingDirectory: WORKDIR,
    model: process.env.CODEX_BRIDGE_PEER_MODEL,
    profile: process.env.CODEX_BRIDGE_PEER_PROFILE,
  })

  await markInProgress(bridgeFetch, message.id, `Running codex exec in ${WORKDIR}`)

  const proc = Bun.spawn([CODEX_BIN, ...args], {
    cwd: WORKDIR,
    env: {
      ...process.env,
      CODEX_BRIDGE_ROOM: '',
      CODEX_BRIDGE_TOKEN: '',
    },
    stdin: 'ignore',
    stdout: 'inherit',
    stderr: 'inherit',
  })

  const exitCode = await proc.exited
  let replyText = ''

  if (existsSync(outputFile)) {
    replyText = readFileSync(outputFile, 'utf8').trim()
    try { unlinkSync(outputFile) } catch {}
  }

  const validation = validateBridgeTextPayload(replyText)
  if (validation.ok) {
    return validation.text
  }

  if (exitCode === 0) {
    return 'Codex peer completed without a usable reply. Please retry with a more specific request.'
  }

  return `Codex peer failed with exit code ${exitCode}. Check the codex-peer terminal for details.`
}

async function handleMessage(
  config: RuntimeConfig,
  bridgeFetch: (path: string, init?: RequestInit) => Promise<Response>,
  message: BridgeMessage,
) {
  try {
    const reply = await runCodexExec(config, bridgeFetch, message)
    await sendReply(bridgeFetch, message.id, reply)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    await sendReply(bridgeFetch, message.id, `Codex peer error: ${detail}`)
  }
}

async function pollLoop(
  config: RuntimeConfig,
  bridgeFetch: (path: string, init?: RequestInit) => Promise<Response>,
) {
  while (true) {
    try {
      const res = await bridgeFetch(
        `/pending-for-claude?timeout=${POLL_TIMEOUT_MS}`,
        { signal: AbortSignal.timeout(POLL_TIMEOUT_MS + 5000) },
      )
      exitOnAuthFail(res.status, 'pending-for-claude')
      if (!res.ok) {
        await Bun.sleep(POLL_BACKOFF_MS)
        continue
      }

      const data = await res.json() as { messages: BridgeMessage[] }
      for (const message of data.messages) {
        await handleMessage(config, bridgeFetch, message)
      }
    } catch {
      await Bun.sleep(POLL_BACKOFF_MS)
    }
  }
}

if (import.meta.main) {
  const config = getRuntimeConfig()
  const bridgeFetch = createBridgeFetch(config)

  process.on('exit', () => { void unregister(bridgeFetch) })
  process.on('SIGINT', () => { void unregister(bridgeFetch).finally(() => process.exit(0)) })
  process.on('SIGTERM', () => { void unregister(bridgeFetch).finally(() => process.exit(0)) })

  if (Number.isInteger(PARENT_PID) && PARENT_PID > 0) {
    setInterval(() => {
      try {
        process.kill(PARENT_PID, 0)
      } catch {
        process.exit(0)
      }
    }, 1000)
  }

  await heartbeat(config, bridgeFetch)
  setInterval(() => { void heartbeat(config, bridgeFetch) }, HEARTBEAT_INTERVAL_MS)
  process.stderr.write(`[codex-peer] polling room ${config.roomId} at ${BRIDGE_URL} from ${WORKDIR}\n`)
  await pollLoop(config, bridgeFetch)
}
