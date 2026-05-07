#!/usr/bin/env bun
/**
 * covering-bridge — Room manager CLI for the Codex-Claude multi-room bridge.
 */

import { createInterface } from 'readline'
import { spawnSync } from 'child_process'
import { readFileSync, statSync } from 'fs'

import { getTerminalSessions, shutdownRoomTerminals } from './room-terminals'

const BRIDGE_URL = process.env.CODEX_BRIDGE_URL ?? 'http://localhost:8788'
const BRIDGE_DIR = new URL('.', import.meta.url).pathname
const SELF_PATH = new URL(import.meta.url).pathname
const VERSION = 'v0.4'
const DASHBOARD_REFRESH_MS = Math.max(1000, Number(process.env.CODEX_BRIDGE_REFRESH_MS ?? 1500))
const PANE_TITLE_TMUX_SESSION = 'cbridge-pane-title-updater'
const PANE_TITLE_HEADER_VERSION = '2'

type Room = {
  id: string
  createdAt: number
  assistantType?: 'claude' | 'codex'
  assistantConnected?: boolean
  claudeConnected: boolean
  codexConnected: boolean
  lastActivity: number
}

type PromptSummaryCache = {
  mtimeMs: number
  size: number
  prompt: string
}

type PaneRole = 'leader' | 'peer'

type BridgeProcess = {
  roomId: string
  role: PaneRole
}

type TmuxPane = {
  target: string
  paneId: string
  sessionName: string
  panePid: number
  role: PaneRole
  roleLabel: string
  width: number
  height: number
}

type TmuxTitleHeaderPane = {
  target: string
  paneId: string
  sessionName: string
  headerFor: string
  version: string
}

// ── ANSI helpers ──

const C = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  bcyan:   '\x1b[96m',
  green:   '\x1b[32m',
  bgreen:  '\x1b[92m',
  purple:  '\x1b[33m',   // orange (256-color fallback: yellow-ish)
  bpurple: '\x1b[38;5;208m',  // bright orange
  yellow:  '\x1b[33m',
  gray:    '\x1b[90m',
  red:     '\x1b[31m',
}

function vis(s: string) { return s.replace(/\x1b\[[0-9;]*m/g, '') }

/** Visual column width, accounting for CJK double-width characters. */
function visWidth(s: string): number {
  let w = 0
  for (const ch of vis(s)) {
    const cp = ch.codePointAt(0) ?? 0
    w += (
      (cp >= 0x1100 && cp <= 0x115F) ||  // Hangul Jamo
      (cp >= 0xAC00 && cp <= 0xD7AF) ||  // Hangul Syllables
      (cp >= 0x4E00 && cp <= 0x9FFF) ||  // CJK Unified
      (cp >= 0x3000 && cp <= 0x303F) ||  // CJK Symbols
      (cp >= 0xFF00 && cp <= 0xFF60)      // Fullwidth Forms
    ) ? 2 : 1
  }
  return w
}

function rpad(s: string, n: number) {
  const diff = n - visWidth(s)
  return diff > 0 ? s + ' '.repeat(diff) : s
}

function sanitizePaneTitle(value: string): string {
  return vis(value)
    .replace(/[#\n\r\t]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateVisible(s: string, maxWidth: number): string {
  if (visWidth(s) <= maxWidth) return s
  let width = 0
  let out = ''
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const chWidth = (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0x3000 && cp <= 0x303F) ||
      (cp >= 0xFF00 && cp <= 0xFF60)
    ) ? 2 : 1
    if (width + chWidth > maxWidth - 1) break
    out += ch
    width += chWidth
  }
  return `${out}…`
}

function takeVisible(s: string, maxWidth: number): [string, string] {
  if (maxWidth <= 0) return ['', s]
  let width = 0
  let out = ''
  let index = 0
  for (const ch of s) {
    const cp = ch.codePointAt(0) ?? 0
    const chWidth = (
      (cp >= 0x1100 && cp <= 0x115F) ||
      (cp >= 0xAC00 && cp <= 0xD7AF) ||
      (cp >= 0x4E00 && cp <= 0x9FFF) ||
      (cp >= 0x3000 && cp <= 0x303F) ||
      (cp >= 0xFF00 && cp <= 0xFF60)
    ) ? 2 : 1
    if (width + chWidth > maxWidth) break
    out += ch
    width += chWidth
    index += ch.length
  }
  return [out.trimEnd(), s.slice(index).trimStart()]
}

function titleLines(prefixText: string, prompt: string, width: number): [string, string] {
  const lineWidth = Math.max(18, width - 2)
  const prefix = `${prefixText} `
  const normalizedPrompt = sanitizePaneTitle(prompt)
  const [firstPrompt, remaining] = takeVisible(normalizedPrompt, Math.max(0, lineWidth - visWidth(prefix)))
  return [
    `${prefix}${firstPrompt}`.trimEnd(),
    truncateVisible(remaining, lineWidth),
  ]
}

function isInternalRoomId(value: string): boolean {
  return /^(LEADER|PEER)-\d+$/i.test(value)
}

function isIssueLikeId(value: string): boolean {
  return /^[A-Z]{2,10}-\d+$/.test(value) && !isInternalRoomId(value)
}

function extractWorkLabelFromText(value: string): string | undefined {
  const text = sanitizePaneTitle(value)
  const docMatches = [
    ...text.matchAll(/\b([A-Z]{2,10}-\d+)[^/\s`'"]*\.(?:task-state|linear)\.md\b/g),
  ]
  for (let i = docMatches.length - 1; i >= 0; i--) {
    const label = docMatches[i]?.[1]
    if (label && isIssueLikeId(label)) return label
  }

  const issueMatches = [...text.matchAll(/\b([A-Z]{2,10}-\d+)\b/g)]
  for (let i = issueMatches.length - 1; i >= 0; i--) {
    const label = issueMatches[i]?.[1]
    if (label && isIssueLikeId(label)) return label
  }

  return undefined
}

function titlePrefixForPane(pane: TmuxPane, roomId: string, workLabel?: string): string {
  const parts = [pane.roleLabel]
  const primaryContext = workLabel ?? (isIssueLikeId(roomId) ? roomId : undefined)
  if (primaryContext && primaryContext !== pane.roleLabel) parts.push(primaryContext)
  if (
    roomId &&
    roomId !== pane.roleLabel &&
    roomId !== primaryContext &&
    !isInternalRoomId(roomId)
  ) {
    parts.push(roomId)
  }
  return parts.join(' · ')
}

const BOX = 54
function boxTop()    { return `  ${C.gray}╭${'─'.repeat(BOX)}╮${C.reset}` }
function boxBottom() { return `  ${C.gray}╰${'─'.repeat(BOX)}╯${C.reset}` }
function boxRow(content: string) {
  const pad = BOX - visWidth(content)
  return `  ${C.gray}│${C.reset}${content}${' '.repeat(Math.max(0, pad))}${C.gray}│${C.reset}`
}
function divider() { return `  ${C.gray}${'─'.repeat(BOX)}${C.reset}` }

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

// ── Bridge server management ──

async function isBridgeRunning(): Promise<boolean> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/rooms`, { signal: AbortSignal.timeout(2000) })
    return res.ok && Array.isArray(await res.json())
  } catch { return false }
}

async function startBridgeServer(): Promise<void> {
  const serverPath = `${BRIDGE_DIR}bridge-server.ts`
  const proc = Bun.spawn(['bun', serverPath], { stdout: 'ignore', stderr: 'ignore', stdin: 'ignore' })
  proc.unref()
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(300)
    if (await isBridgeRunning()) return
  }
  throw new Error(`Bridge server did not start. Check: bun ${serverPath}`)
}

async function ensureBridge(): Promise<void> {
  if (await isBridgeRunning()) return
  await startBridgeServer()
}

// ── Room API ──

async function getRooms(): Promise<Room[]> {
  try {
    const res = await fetch(`${BRIDGE_URL}/api/rooms`, { signal: AbortSignal.timeout(3000) })
    if (!res.ok) return []
    const data = await res.json()
    return Array.isArray(data) ? data as Room[] : []
  } catch { return [] }
}

async function closeRoom(roomId: string): Promise<boolean> {
  try {
    const res = await fetch(
      `${BRIDGE_URL}/api/rooms/${encodeURIComponent(roomId)}`,
      { method: 'DELETE', signal: AbortSignal.timeout(3000) },
    )
    return res.status === 204
  } catch { return false }
}

// ── Display ──

const promptSummaryCache = new Map<string, PromptSummaryCache>()

function roomIdFromProcessLine(line: string): string | undefined {
  const raw = line.match(/\bCODEX_BRIDGE_ROOM=("[^"]+"|'[^']+'|\S+)/)?.[1]
  return raw?.replace(/^['"]|['"]$/g, '')
}

function getBridgeProcesses(): Map<number, BridgeProcess> {
  const result = new Map<number, BridgeProcess>()
  try {
    const out = spawnSync('ps', ['eww', '-axo', 'pid=,command='], { encoding: 'utf8' }).stdout ?? ''
    for (const line of out.split('\n')) {
      const isLeader = /\/codex\/codex\s/.test(line)
      const isPeer = /\bcodex-peer-agent\.ts\b/.test(line)
      if (!isLeader && !isPeer) continue
      const room = roomIdFromProcessLine(line)
      if (!room) continue
      const pid = Number(line.trim().match(/^(\d+)/)?.[1])
      if (!Number.isFinite(pid)) continue
      result.set(pid, { roomId: room, role: isPeer ? 'peer' : 'leader' })
    }
  } catch {}
  return result
}

function getLeaderCodexProcesses(): Map<number, string> {
  const result = new Map<number, string>()
  for (const [pid, processInfo] of getBridgeProcesses()) {
    if (processInfo.role === 'leader') result.set(pid, processInfo.roomId)
  }
  return result
}

function getOpenCodexSessionFiles(pids: number[]): Map<number, string> {
  const result = new Map<number, string>()
  const mtimes = new Map<number, number>()
  if (pids.length === 0) return result
  try {
    const out = spawnSync('lsof', ['-p', pids.join(',')], { encoding: 'utf8' }).stdout ?? ''
    for (const line of out.split('\n')) {
      if (!line.endsWith('.jsonl')) continue
      const pid = Number(line.match(/^\S+\s+(\d+)\s/)?.[1])
      const pathStart = line.indexOf('/Users/')
      if (!Number.isFinite(pid) || pathStart < 0) continue
      const path = line.slice(pathStart)
      let mtimeMs = 0
      try {
        mtimeMs = statSync(path).mtimeMs
      } catch {}
      if (!result.has(pid) || mtimeMs >= (mtimes.get(pid) ?? 0)) {
        result.set(pid, path)
        mtimes.set(pid, mtimeMs)
      }
    }
  } catch {}
  return result
}

function cleanUserPrompt(raw: string): string | undefined {
  const normalized = raw.replace(/\s+/g, ' ').trim()
  if (!normalized) return undefined
  if (normalized.startsWith('# AGENTS.md instructions')) return undefined
  if (normalized.startsWith('<hook_prompt')) return undefined
  if (normalized.startsWith('<environment_context>')) return undefined
  if (normalized.startsWith('You are the responder in a Codex-Codex Bridge room')) return undefined

  const withoutSessionPath = normalized
    .replace(/\/Users\/wjh\/\S+?\.jsonl/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return withoutSessionPath || undefined
}

function extractPromptText(record: any): string | undefined {
  if (record?.type === 'response_item' && record?.payload?.type === 'message' && record?.payload?.role === 'user') {
    const parts = Array.isArray(record.payload.content)
      ? record.payload.content
          .filter((item: any) => item?.type === 'input_text' || item?.type === 'text')
          .map((item: any) => String(item.text ?? ''))
      : []
    return parts.join(' ')
  }
  if (record?.type === 'event_msg' && record?.payload?.type === 'user_message') {
    return String(record.payload.message ?? '')
  }
  return undefined
}

function latestPromptSummaryFromFile(path: string): string {
  try {
    const stat = statSync(path)
    const cached = promptSummaryCache.get(path)
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) return cached.prompt

    const prompts: string[] = []
    const seen = new Set<string>()
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1; i >= 0 && prompts.length < 4; i--) {
      try {
        const text = cleanUserPrompt(extractPromptText(JSON.parse(lines[i])) ?? '')
        if (!text || seen.has(text)) continue
        seen.add(text)
        prompts.unshift(text)
      } catch {}
    }

    const prompt = prompts[prompts.length - 1] ?? '최근 프롬프트 없음'
    promptSummaryCache.set(path, { mtimeMs: stat.mtimeMs, size: stat.size, prompt })
    return prompt
  } catch {
    return '최근 프롬프트 확인 불가'
  }
}

function latestWorkLabelFromFile(path: string): string | undefined {
  try {
    const lines = readFileSync(path, 'utf8').trimEnd().split('\n')
    for (let i = lines.length - 1, checked = 0; i >= 0 && checked < 80; i--, checked++) {
      const line = lines[i] ?? ''
      try {
        const text = cleanUserPrompt(extractPromptText(JSON.parse(line)) ?? '')
        const label = text ? extractWorkLabelFromText(text) : undefined
        if (label) return label
      } catch {}

      if (
        line.includes('.task-state.md') ||
        line.includes('.linear.md')
      ) {
        const label = extractWorkLabelFromText(line)
        if (label) return label
      }
    }
  } catch {}
  return undefined
}

function tmux(args: string[]): void {
  spawnSync('tmux', args, { stdout: 'ignore', stderr: 'ignore' })
}

function tmuxOutput(args: string[]): string {
  try {
    return spawnSync('tmux', args, { encoding: 'utf8' }).stdout ?? ''
  } catch {
    return ''
  }
}

function isCbridgeTitleSession(sessionName: string): boolean {
  return (
    sessionName.startsWith('cbridge-leaders-') ||
    sessionName.startsWith('cbridge-peer-') ||
    sessionName === 'cbridge-peers'
  )
}

function peerLabelFromSession(sessionName: string, roomId?: string): string {
  const sessionMatch = sessionName.match(/^cbridge-peer-(.+)$/)?.[1]
  if (sessionMatch) return `PEER-${sessionMatch}`
  const roomMatch = roomId?.match(/^LEADER-(\d+)$/i)?.[1]
  if (roomMatch) return `PEER-${roomMatch}`
  return 'PEER'
}

function leaderLabelFromRoom(roomId?: string): string {
  return roomId && /^LEADER-\d+$/i.test(roomId) ? roomId.toUpperCase() : 'LEADER'
}

function getTmuxBridgePanes(processes: Map<number, BridgeProcess>): TmuxPane[] {
  const panes: TmuxPane[] = []
  try {
    const out = tmuxOutput([
      'list-panes',
      '-a',
      '-F',
      '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_width}\t#{pane_height}',
    ])

    for (const line of out.split('\n')) {
      const [sessionName, paneId, panePidRaw, command, widthRaw, heightRaw] = line.split('\t')
      const panePid = Number(panePidRaw)
      const width = Number(widthRaw)
      const height = Number(heightRaw)
      if (!Number.isFinite(panePid)) continue
      const processInfo = processes.get(panePid)
      if (sessionName?.startsWith('cbridge-leaders-')) {
        if (command !== 'codex') continue
        panes.push({
          sessionName,
          paneId,
          panePid,
          role: 'leader',
          roleLabel: leaderLabelFromRoom(processInfo?.roomId),
          width: Number.isFinite(width) ? width : 80,
          height: Number.isFinite(height) ? height : 24,
          target: paneId,
        })
        continue
      }
      if (sessionName?.startsWith('cbridge-peer-') || sessionName === 'cbridge-peers') {
        if (command !== 'bun') continue
        panes.push({
          sessionName,
          paneId,
          panePid,
          role: 'peer',
          roleLabel: peerLabelFromSession(sessionName, processInfo?.roomId),
          width: Number.isFinite(width) ? width : 80,
          height: Number.isFinite(height) ? height : 24,
          target: paneId,
        })
      }
    }
  } catch {}
  return panes
}

function getTmuxLeaderPanes(): TmuxPane[] {
  const processes = getBridgeProcesses()
  return getTmuxBridgePanes(processes).filter(pane => pane.role === 'leader')
}

function getTmuxTitleHeaders(): TmuxTitleHeaderPane[] {
  const headers: TmuxTitleHeaderPane[] = []
  const out = tmuxOutput([
    'list-panes',
    '-a',
    '-F',
    '#{session_name}\t#{pane_id}\t#{@cbridge_header_for}\t#{@cbridge_title_header_version}',
  ])

  for (const line of out.split('\n')) {
    const [sessionName, paneId, headerFor, version] = line.split('\t')
    if (!sessionName || !isCbridgeTitleSession(sessionName)) continue
    if (!paneId || !headerFor?.startsWith('%')) continue
    headers.push({ sessionName, paneId, headerFor, version, target: paneId })
  }
  return headers
}

function cleanupTmuxTitleHeaders(headers: TmuxTitleHeaderPane[], livePaneIds: Set<string>): void {
  const seen = new Set<string>()
  for (const header of headers) {
    if (header.version !== PANE_TITLE_HEADER_VERSION || !livePaneIds.has(header.headerFor) || seen.has(header.headerFor)) {
      tmux(['kill-pane', '-t', header.target])
      continue
    }
    seen.add(header.headerFor)
  }
}

function tmuxTitleHeaderCommand(targetPaneId: string): string {
  const interval = String(Math.max(1, DASHBOARD_REFRESH_MS / 1000))
  return [
    'while :; do',
    `line1=$(tmux display-message -p -t ${shellQuote(targetPaneId)} ${shellQuote('#{@cbridge_title_line_1}')} 2>/dev/null) || exit 0;`,
    `line2=$(tmux display-message -p -t ${shellQuote(targetPaneId)} ${shellQuote('#{@cbridge_title_line_2}')} 2>/dev/null) || exit 0;`,
    `printf '\\033[?7l\\033[?25l\\033[H\\033[2K\\033[96;1m%s\\033[0m\\n\\033[2K\\033[93;1m%s\\033[0m' "$line1" "$line2";`,
    `sleep ${shellQuote(interval)};`,
    'done',
  ].join(' ')
}

function ensureTmuxTitleHeader(pane: TmuxPane, headersByPane: Map<string, TmuxTitleHeaderPane>): void {
  const existing = headersByPane.get(pane.paneId)
  if (existing) {
    tmux(['resize-pane', '-t', existing.target, '-y', '2'])
    tmux(['select-pane', '-t', existing.target, '-T', ''])
    return
  }
  if (pane.height < 8) return

  const headerId = tmuxOutput([
    'split-window',
    '-v',
    '-b',
    '-l',
    '3',
    '-P',
    '-F',
    '#{pane_id}',
    '-t',
    pane.target,
    tmuxTitleHeaderCommand(pane.paneId),
  ]).trim()
  if (!headerId) return

  tmux(['set-option', '-pt', headerId, '@cbridge_header_for', pane.paneId])
  tmux(['set-option', '-pt', headerId, '@cbridge_title_header', '1'])
  tmux(['set-option', '-pt', headerId, '@cbridge_title_header_version', PANE_TITLE_HEADER_VERSION])
  tmux(['resize-pane', '-t', headerId, '-y', '2'])
  tmux(['select-pane', '-t', headerId, '-T', ''])
  tmux(['select-pane', '-t', pane.target])
  headersByPane.set(pane.paneId, {
    target: headerId,
    paneId: headerId,
    sessionName: pane.sessionName,
    headerFor: pane.paneId,
    version: PANE_TITLE_HEADER_VERSION,
  })
}

function updateTmuxPaneTitlesOnce(): void {
  const processes = getBridgeProcesses()
  const panes = getTmuxBridgePanes(processes)
  const livePaneIds = new Set(panes.map(pane => pane.paneId))
  let headers = getTmuxTitleHeaders()
  cleanupTmuxTitleHeaders(headers, livePaneIds)
  headers = getTmuxTitleHeaders()
  const headersByPane = new Map(
    headers
      .filter(header => livePaneIds.has(header.headerFor))
      .map(header => [header.headerFor, header] as const),
  )

  const leaderPanes = panes.filter(pane => pane.role === 'leader')
  const files = getOpenCodexSessionFiles(leaderPanes.map(pane => pane.panePid))
  const promptByRoom = new Map<string, string>()
  const workLabelByRoom = new Map<string, string>()
  const touchedSessions = new Set<string>()

  for (const pane of leaderPanes) {
    const processInfo = processes.get(pane.panePid)
    if (!processInfo) continue
    const prompt = latestPromptSummaryFromFile(files.get(pane.panePid) ?? '')
    promptByRoom.set(processInfo.roomId, prompt)
    const filePath = files.get(pane.panePid)
    const workLabel = isIssueLikeId(processInfo.roomId)
      ? processInfo.roomId
      : (filePath ? latestWorkLabelFromFile(filePath) : undefined)
    if (workLabel) workLabelByRoom.set(processInfo.roomId, workLabel)
  }

  for (const pane of panes) {
    const processInfo = processes.get(pane.panePid)
    if (!processInfo) continue
    const roomId = processInfo.roomId
    const filePath = pane.role === 'leader' ? files.get(pane.panePid) : undefined
    const prompt = pane.role === 'leader'
      ? latestPromptSummaryFromFile(filePath ?? '')
      : (promptByRoom.get(roomId) ?? '응답자 세션')
    const workLabel = isIssueLikeId(roomId)
      ? roomId
      : (filePath ? latestWorkLabelFromFile(filePath) : workLabelByRoom.get(roomId))
    const prefix = titlePrefixForPane(pane, roomId, workLabel)
    const [line1, line2] = titleLines(prefix, prompt, pane.width)
    tmux(['set-option', '-pt', pane.target, '@cbridge_room', roomId])
    tmux(['set-option', '-pt', pane.target, '@cbridge_work_label', workLabel ?? ''])
    tmux(['set-option', '-pt', pane.target, '@cbridge_prompt', `${line1} ${line2}`.trim()])
    tmux(['set-option', '-pt', pane.target, '@cbridge_title_line_1', line1])
    tmux(['set-option', '-pt', pane.target, '@cbridge_title_line_2', line2])
    tmux(['set-option', '-pt', pane.target, '@cbridge_border_title', `#[fg=colour14,bold]${line1} #[fg=colour245]│ #[fg=colour229,bold]${line2}`])
    tmux(['select-pane', '-t', pane.target, '-T', ''])
    ensureTmuxTitleHeader(pane, headersByPane)
    touchedSessions.add(pane.sessionName)
  }

  for (const sessionName of touchedSessions) {
    tmux(['set-window-option', '-t', `${sessionName}:0`, 'pane-border-status', 'off'])
    tmux(['set-window-option', '-u', '-t', `${sessionName}:0`, 'pane-border-format'])
    tmux(['set-option', '-t', sessionName, 'set-titles', 'off'])
    tmux(['set-option', '-t', sessionName, 'status', 'off'])
    tmux(['set-option', '-u', '-t', sessionName, 'status-format[0]'])
    tmux(['set-option', '-u', '-t', sessionName, 'status-format[1]'])
  }
}

async function watchTmuxPaneTitles(): Promise<void> {
  while (true) {
    updateTmuxPaneTitlesOnce()
    await Bun.sleep(DASHBOARD_REFRESH_MS)
  }
}

function hasTmuxSession(sessionName: string): boolean {
  try {
    return spawnSync('tmux', ['has-session', '-t', sessionName], { stdout: 'ignore', stderr: 'ignore' }).status === 0
  } catch {
    return false
  }
}

function ensureTmuxPaneTitleUpdater(): void {
  if (process.env.CODEX_BRIDGE_PANE_TITLES === '0') return
  if (hasTmuxSession(PANE_TITLE_TMUX_SESSION)) return

  const tmuxCommand = `${shellQuote(process.execPath)} ${shellQuote(SELF_PATH)} tmux-pane-titles --watch`
  tmux([
    'new-session',
    '-d',
    '-s',
    PANE_TITLE_TMUX_SESSION,
    '-c',
    BRIDGE_DIR,
    tmuxCommand,
  ])
}

function formatAge(ts: number): string {
  const secs = Math.floor((Date.now() - ts) / 1000)
  if (secs < 5)    return `${C.bgreen}just now${C.reset}`
  if (secs < 60)   return `${C.gray}${secs}s ago${C.reset}`
  if (secs < 3600) return `${C.gray}${Math.floor(secs / 60)}m ago${C.reset}`
  return `${C.gray}${Math.floor(secs / 3600)}h ago${C.reset}`
}

function agentDot(connected: boolean, onColor: string): string {
  return connected ? `${onColor}●${C.reset}` : `${C.gray}○${C.reset}`
}

function roomAssistantType(room: Room): 'claude' | 'codex' {
  return room.assistantType === 'codex' ? 'codex' : 'claude'
}

function roomAssistantConnected(room: Room): boolean {
  return room.assistantConnected ?? room.claudeConnected
}

function roomAssistantLabel(room: Room): string {
  return roomAssistantType(room) === 'codex' ? 'codex-peer' : 'claude'
}

function roomAssistantColor(room: Room): string {
  return roomAssistantType(room) === 'codex' ? C.bcyan : C.bpurple
}

function parseSelection(pick: string, count: number): number[] {
  return [...new Set(
    pick.split(',')
      .map(s => parseInt(s.trim(), 10) - 1)
      .filter(i => !isNaN(i) && i >= 0 && i < count),
  )]
}

function getTerminalTargets() {
  return [...getTerminalSessions().entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([roomId, sessions]) => ({
      roomId,
      claudeCount: sessions.claude.length,
      codexCount: sessions.codex.length,
      codexPeerCount: sessions.codexPeer.length,
    }))
}

function inferAssistantTypeFromSessions(roomId: string, sessions: ReturnType<typeof getTerminalSessions>): 'claude' | 'codex' | null {
  const session = sessions.get(roomId)
  if (!session) return null
  if (session.codexPeer.length > 0) return 'codex'
  if (session.claude.length > 0) return 'claude'
  return null
}

function displayAssistantType(room: Room, sessions: ReturnType<typeof getTerminalSessions>): 'claude' | 'codex' {
  return inferAssistantTypeFromSessions(room.id, sessions) ?? roomAssistantType(room)
}

function displayAssistantLabel(room: Room, sessions: ReturnType<typeof getTerminalSessions>): string {
  return displayAssistantType(room, sessions) === 'codex' ? 'codex-peer' : 'claude'
}

function displayAssistantColor(room: Room, sessions: ReturnType<typeof getTerminalSessions>): string {
  return displayAssistantType(room, sessions) === 'codex' ? C.bcyan : C.bpurple
}

function terminalSummaryParts(session: { claude: number[]; codex: number[]; codexPeer: number[] }) {
  const parts: string[] = []
  if (session.codexPeer.length > 0) parts.push(`codex-peer ×${session.codexPeer.length}`)
  if (session.claude.length > 0) parts.push(`claude ×${session.claude.length}`)
  if (session.codex.length > 0) parts.push(`codex ×${session.codex.length}`)
  return parts
}

function summarizeShutdown(roomId: string, summary: Awaited<ReturnType<typeof shutdownRoomTerminals>>): string {
  if (summary.matched === 0) {
    return `  ${C.gray}•${C.reset}  ${roomId}: no bridge-launched terminals found.`
  }

  const parts: string[] = []
  if (summary.terminated.length > 0) parts.push(`SIGTERM ${summary.terminated.length}`)
  if (summary.forced.length > 0) parts.push(`SIGKILL ${summary.forced.length}`)
  if (summary.failures.length > 0) parts.push(`failed ${summary.failures.length}`)

  const detail = parts.length > 0 ? parts.join(', ') : 'no-op'
  const tone = summary.failures.length > 0 ? `${C.yellow}•${C.reset}` : `${C.bgreen}•${C.reset}`
  return `  ${tone}  ${roomId}: terminal shutdown ${detail}.`
}

function printRooms(rooms: Room[]): void {
  console.clear()
  console.log()
  const sessions = getTerminalSessions()

  // ── Header ──
  console.log(boxTop())
  console.log(boxRow(`  ${C.bold}${C.bcyan}◈  Codex Bridge${C.reset}  ${C.dim}룸 관리 대시보드${C.reset}  ${C.gray}${VERSION}${C.reset}`))
  console.log(boxRow(`     ${C.dim}multi-room claude/codex-peer bridge${C.reset}`))
  console.log(boxBottom())
  console.log()

  // ── Status ──
  const roomCount = rooms.length === 0
    ? `${C.gray}no active rooms${C.reset}`
    : `${C.bold}${rooms.length}${C.reset} room${rooms.length === 1 ? '' : 's'} active`
  console.log(`  ${roomCount}  ${C.gray}·${C.reset}  ${C.dim}${BRIDGE_URL}${C.reset}`)
  console.log()

  // ── Room list ──
  if (rooms.length === 0) {
    console.log(`  ${C.gray}No rooms yet. Press ${C.reset}${C.bold}o${C.reset}${C.gray} to open one.${C.reset}`)
  } else {
    for (const r of [...rooms].sort((a, b) => a.id.localeCompare(b.id))) {
      const codex  = agentDot(r.codexConnected,  C.bgreen)
      const assistant = agentDot(roomAssistantConnected(r), displayAssistantColor(r, sessions))
      const codexL  = r.codexConnected  ? `${C.green}codex${C.reset}`  : `${C.gray}codex${C.reset}`
      const assistantL = roomAssistantConnected(r)
        ? `${displayAssistantColor(r, sessions)}${displayAssistantLabel(r, sessions)}${C.reset}`
        : `${C.gray}${displayAssistantLabel(r, sessions)}${C.reset}`
      const id  = rpad(`${C.bold}${r.id}${C.reset}`, 14)
      const age = formatAge(r.lastActivity)
      console.log(`  ${id}  ${codex} ${codexL}   ${assistant} ${assistantL}   ${age}`)
    }
  }
  // ── Terminal sessions (dim) ──
  if (sessions.size > 0) {
    const sorted = [...sessions.entries()].sort(([a], [b]) => a.localeCompare(b))
    console.log(`  ${C.dim}terminals${C.reset}`)
    for (const [roomId, s] of sorted) {
      const parts = terminalSummaryParts(s)
      const label = parts.length > 0 ? parts.join('   ') : 'no active terminals'
      console.log(`  ${C.dim}${roomId.padEnd(14)}  ${label}${C.reset}`)
    }
  }
  console.log()

  // ── Footer ──
  console.log(divider())
  const keys = [
    `${C.bold}o${C.reset} open`,
    `${C.bold}c${C.reset} close`,
    `${C.bold}t${C.reset} terminals`,
    `${C.bold}r${C.reset} refresh`,
    `${C.bold}q${C.reset} quit`,
  ]
  console.log(`  ${keys.join(`  ${C.gray}·${C.reset}  `)}`)
  console.log(divider())
  console.log()
}

// ── Terminal opening ──

function detectEnv(): 'tmux' | 'iterm2' | 'terminal' | 'none' {
  if (process.env.TMUX) return 'tmux'
  if (process.env.TERM_PROGRAM === 'iTerm.app') return 'iterm2'
  if (process.env.TERM_PROGRAM === 'Apple_Terminal') return 'terminal'
  return 'none'
}

function openWithTmux(roomId: string, cmd1: string, cmd2: string): void {
  spawnSync('tmux', ['new-window', '-n', roomId, cmd1])
  spawnSync('tmux', ['split-window', '-h', cmd2])
  spawnSync('tmux', ['select-pane', '-L'])
}

function openWithAppleScript(
  app: 'iTerm' | 'Terminal',
  roomId: string,
  assistantName: string,
  cmd1: string,
  cmd2: string,
): void {
  const script = app === 'iTerm' ? `
tell application "iTerm"
  activate
  set t to (create tab with default profile)
  tell current session of t
    set name to "${roomId} (${assistantName})"
    write text "${cmd1}"
  end tell
  set t2 to (create tab with default profile)
  tell current session of t2
    set name to "${roomId} (codex)"
    write text "${cmd2}"
  end tell
end tell` : `
tell application "Terminal"
  activate
  do script "${cmd1}"
  do script "${cmd2}"
end tell`
  spawnSync('osascript', ['-e', script])
}

function openRoom(roomId: string, assistantType: 'claude' | 'codex'): 'auto' | 'manual' {
  const assistantCmd = assistantType === 'codex'
    ? `bridge-codex-peer ${roomId}`
    : `bridge-claude ${roomId}`
  const assistantName = assistantType === 'codex' ? 'codex-peer' : 'claude'
  const codexCmd  = `bridge-codex ${roomId}`
  const env = detectEnv()
  if (env === 'tmux')     { openWithTmux(roomId, assistantCmd, codexCmd); return 'auto' }
  if (env === 'iterm2')   { openWithAppleScript('iTerm',    roomId, assistantName, assistantCmd, codexCmd); return 'auto' }
  if (env === 'terminal') { openWithAppleScript('Terminal', roomId, assistantName, assistantCmd, codexCmd); return 'auto' }
  return 'manual'
}

// ── Interactive prompt ──

function prompt(rl: ReturnType<typeof createInterface>, question: string): Promise<string> {
  return new Promise(resolve => rl.question(question, resolve))
}

// ── Main ──

async function main(): Promise<void> {
  process.stdout.write(`\n  ${C.dim}Connecting to bridge...${C.reset} `)
  try {
    await ensureBridge()
    ensureTmuxPaneTitleUpdater()
    console.log(`${C.bgreen}ready${C.reset}\n`)
  } catch (err) {
    console.error(`\n  ${C.red}✗${C.reset} ${err instanceof Error ? err.message : err}`)
    process.exit(1)
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout })

  while (true) {
    const rooms = await getRooms()
    printRooms(rooms)

    const choice = (await prompt(rl, `  ${C.bcyan}›${C.reset} `)).trim().toLowerCase()

    if (choice === 'q' || choice === 'quit') {
      rl.close()
      console.log(`\n  ${C.dim}bye.${C.reset}\n`)
      process.exit(0)
    }

    if (choice === 'r' || choice === 'refresh') continue

    if (choice === 'o' || choice === 'open') {
      const ticketRaw = (await prompt(rl, `  ${C.gray}Room ID (e.g. ENG-1234):${C.reset} `)).trim()
      const ticket = ticketRaw.toUpperCase()
      if (!ticket) { console.log(`  ${C.gray}Cancelled.${C.reset}`); continue }
      const assistantTypeRaw = (await prompt(
        rl,
        `  ${C.gray}Assistant type [claude/codex] (default: claude):${C.reset} `,
      )).trim().toLowerCase()
      const assistantType = assistantTypeRaw === 'codex' ? 'codex' : 'claude'
      if (rooms.find(r => r.id === ticket)) {
        console.log(`  ${C.yellow}⚠${C.reset}  Room ${C.bold}${ticket}${C.reset} already exists.`)
        await Bun.sleep(900)
        continue
      }
      await fetch(`${BRIDGE_URL}/api/rooms/${encodeURIComponent(ticket)}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ assistantType }),
      }).catch(() => {})
      const mode = openRoom(ticket, assistantType)
      if (mode === 'manual') {
        if (assistantType === 'codex') {
          console.log(`\n  ${C.gray}[codex-peer]${C.reset}  bridge-codex-peer ${ticket}`)
        } else {
          console.log(`\n  ${C.gray}[claude]${C.reset}  bridge-claude ${ticket}`)
        }
        console.log(`  ${C.gray}[codex] ${C.reset}  bridge-codex ${ticket}\n`)
        await prompt(rl, `  ${C.gray}Press Enter once both terminals are running...${C.reset} `)
      } else {
        await Bun.sleep(800)
      }
      continue
    }

    if (choice === 't' || choice === 'terminal' || choice === 'terminals') {
      const terminalTargets = getTerminalTargets()
      if (terminalTargets.length === 0) {
        console.log(`  ${C.gray}No terminals to stop.${C.reset}`)
        await Bun.sleep(700)
        continue
      }

      console.log()
      terminalTargets.forEach((target, i) => {
        const parts: string[] = []
        if (target.claudeCount > 0) parts.push(`${C.purple}claude${C.reset} ×${target.claudeCount}`)
        if (target.codexCount > 0) parts.push(`${C.green}codex${C.reset} ×${target.codexCount}`)
        if (target.codexPeerCount > 0) parts.push(`${C.bcyan}codex-peer${C.reset} ×${target.codexPeerCount}`)
        console.log(`  ${C.bold}[${i + 1}]${C.reset}  ${C.bold}${target.roomId}${C.reset}   ${parts.join('   ')}`)
      })

      const pick = (await prompt(
        rl,
        `\n  ${C.gray}Stop terminal # — single or comma-separated (e.g. 1,2,3):${C.reset} `,
      )).trim()

      if (pick) {
        const indices = parseSelection(pick, terminalTargets.length)
        for (const idx of indices) {
          const target = terminalTargets[idx]
          const summary = await shutdownRoomTerminals(target.roomId)
          console.log(summarizeShutdown(target.roomId, summary))
        }
        if (indices.length > 0) await Bun.sleep(700)
      }
      continue
    }

    if (choice === 'c' || choice === 'close') {
      if (rooms.length === 0) { console.log(`  ${C.gray}No rooms to close.${C.reset}`); await Bun.sleep(700); continue }
      console.log()
      const sorted = [...rooms].sort((a, b) => a.id.localeCompare(b.id))
      sorted.forEach((r, i) => {
        const codex  = r.codexConnected  ? `${C.bgreen}◉${C.reset}`  : `${C.gray}◯${C.reset}`
        const assistant = roomAssistantConnected(r) ? `${roomAssistantColor(r)}◉${C.reset}` : `${C.gray}◯${C.reset}`
        console.log(`  ${C.bold}[${i + 1}]${C.reset}  ${C.bold}${r.id}${C.reset}   ${codex} codex  ${assistant} ${roomAssistantLabel(r)}`)
      })
      const pick = (await prompt(rl, `\n  ${C.gray}Close room # — single or comma-separated (e.g. 1,2,3):${C.reset} `)).trim()
      if (pick) {
        const indices = parseSelection(pick, sorted.length)
        for (const idx of indices) {
          const target = sorted[idx].id
          const ok = await closeRoom(target)
          const shutdown = await shutdownRoomTerminals(target)
          console.log(ok
            ? `  ${C.bgreen}✓${C.reset}  ${C.bold}${target}${C.reset} closed.`
            : `  ${C.red}✗${C.reset}  Failed to close ${target}.`)
          console.log(summarizeShutdown(target, shutdown))
        }
        if (indices.length > 0) await Bun.sleep(700)
      }
      continue
    }
  }
}

if (process.argv[2] === 'tmux-pane-titles') {
  if (process.argv.includes('--start')) {
    ensureTmuxPaneTitleUpdater()
    process.exit(0)
  }
  updateTmuxPaneTitlesOnce()
  if (process.argv.includes('--watch')) {
    await watchTmuxPaneTitles()
  }
  process.exit(0)
}

await main()
