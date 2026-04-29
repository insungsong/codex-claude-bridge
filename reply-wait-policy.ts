import type { ReplyProgressSnapshot } from './bridge-reply-progress'

export type ReplyWaitPolicyOptions = {
  baseWaitMs: number
  claimWaitMs: number
  maxWaitMs: number
  staleProgressMs: number
}

export const DEFAULT_REPLY_WAIT_POLICY: ReplyWaitPolicyOptions = {
  baseWaitMs: 110_000,
  claimWaitMs: 30_000,
  maxWaitMs: 600_000,
  staleProgressMs: 120_000,
}

export function latestReplyActivityAt(status: ReplyProgressSnapshot) {
  return status.lastProgressAt ?? status.deliveredAt ?? status.createdAt
}

export function hasFreshReplyActivity(
  status: ReplyProgressSnapshot,
  now = Date.now(),
  options: ReplyWaitPolicyOptions = DEFAULT_REPLY_WAIT_POLICY,
) {
  return now - latestReplyActivityAt(status) <= options.staleProgressMs
}

export function shouldKeepWaitingForReply(
  startedAt: number,
  status: ReplyProgressSnapshot | null | undefined,
  now = Date.now(),
  options: ReplyWaitPolicyOptions = DEFAULT_REPLY_WAIT_POLICY,
  peerAlive = false,
) {
  const elapsedMs = now - startedAt

  if (elapsedMs >= options.maxWaitMs) return false

  if (status?.state === 'delivered') {
    const deliveredAt = status.deliveredAt ?? status.createdAt
    if (now - deliveredAt > options.claimWaitMs) return false
  }

  if (elapsedMs < options.baseWaitMs) return true

  // No status after the base window means the bridge cannot prove active work.
  if (!status) return false

  // Queued = bridge hasn't delivered to assistant yet. A heartbeat alone is not work progress.
  if (status.state === 'queued') return peerAlive && hasFreshReplyActivity(status, now, options)

  // Delivered but not claimed should not consume the full max wait window.
  if (status.state === 'delivered') return hasFreshReplyActivity(status, now, options)

  // In-progress requests must keep emitting fresh progress to justify long waits.
  if (status.state === 'in_progress') return hasFreshReplyActivity(status, now, options)

  return false
}
