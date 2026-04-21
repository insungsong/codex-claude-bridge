import type { ReplyProgressSnapshot } from './bridge-reply-progress'

export type ReplyWaitPolicyOptions = {
  baseWaitMs: number
  maxWaitMs: number
  staleProgressMs: number
}

export const DEFAULT_REPLY_WAIT_POLICY: ReplyWaitPolicyOptions = {
  baseWaitMs: 110_000,
  maxWaitMs: 600_000,
  staleProgressMs: 120_000,
}

export function latestReplyActivityAt(status: ReplyProgressSnapshot) {
  return status.lastProgressAt ?? status.deliveredAt ?? status.createdAt
}

export function shouldKeepWaitingForReply(
  startedAt: number,
  status: ReplyProgressSnapshot | null | undefined,
  now = Date.now(),
  options: ReplyWaitPolicyOptions = DEFAULT_REPLY_WAIT_POLICY,
  peerAlive = false,
) {
  const elapsedMs = now - startedAt

  if (elapsedMs < options.baseWaitMs) return true
  if (elapsedMs >= options.maxWaitMs) return false

  // No status yet: only keep waiting if the peer session is actively connected.
  if (!status) return peerAlive

  // Queued = bridge hasn't delivered to assistant yet. Wait only if peer is alive.
  if (status.state === 'queued') return peerAlive

  // Delivered or in_progress + peer alive: heartbeat counts as activity — keep waiting.
  if (peerAlive) return true

  // Peer disconnected: fall back to stale-progress check so we don't wait on a dead session.
  const lastActivityAt = latestReplyActivityAt(status)
  return now - lastActivityAt <= options.staleProgressMs
}
