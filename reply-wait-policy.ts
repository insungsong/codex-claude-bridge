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
) {
  const elapsedMs = now - startedAt

  if (elapsedMs < options.baseWaitMs) return true
  if (elapsedMs >= options.maxWaitMs) return false
  if (!status) return false
  if (status.state === 'queued') return false

  const lastActivityAt = latestReplyActivityAt(status)
  return now - lastActivityAt <= options.staleProgressMs
}
