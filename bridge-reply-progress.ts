export type ReplyProgressState = 'queued' | 'delivered' | 'in_progress' | 'replied'

export type ReplyProgress = {
  state: ReplyProgressState
  createdAt: number
  deliveredAt?: number
  lastProgressAt?: number
  progressNote?: string
  repliedAt?: number
}

export type ReplyProgressSnapshot = ReplyProgress & {
  id: string
}

function formatAge(now: number, ts: number) {
  return `${Math.max(1, Math.round((now - ts) / 1000))}s`
}

export function createReplyProgress(now = Date.now()): ReplyProgress {
  return {
    state: 'queued',
    createdAt: now,
  }
}

export function markReplyDelivered(progress: ReplyProgress, now = Date.now()) {
  progress.deliveredAt ??= now
  if (progress.state === 'queued') {
    progress.state = 'delivered'
  }
}

export function markReplyInProgress(
  progress: ReplyProgress,
  note?: string,
  now = Date.now(),
) {
  if (progress.state === 'replied') return
  progress.state = 'in_progress'
  progress.deliveredAt ??= now
  progress.lastProgressAt = now
  const trimmed = note?.trim()
  if (trimmed) progress.progressNote = trimmed
}

export function markReplyCompleted(progress: ReplyProgress, now = Date.now()) {
  progress.state = 'replied'
  progress.repliedAt = now
  progress.lastProgressAt ??= now
}

export function formatReplyProgressStatus(
  progress: ReplyProgress,
  now = Date.now(),
  assistantName = 'Claude',
) {
  switch (progress.state) {
    case 'queued':
      return `The bridge has not observed ${assistantName} receive or claim the request yet.`
    case 'delivered':
      if (progress.deliveredAt) {
        return `${assistantName} received the request ${formatAge(now, progress.deliveredAt)} ago, but has not reported active progress yet.`
      }
      return `${assistantName} received the request, but has not reported active progress yet.`
    case 'in_progress': {
      const parts = [`${assistantName} is still working on the request`]
      if (progress.lastProgressAt) {
        parts.push(`last progress ${formatAge(now, progress.lastProgressAt)} ago`)
      }
      let text = parts.join(' (')
      if (parts.length > 1) text += ')'
      if (progress.progressNote) {
        text += ` — ${progress.progressNote}`
      }
      return `${text}.`
    }
    case 'replied':
      if (progress.repliedAt) {
        return `${assistantName} finished preparing a reply ${formatAge(now, progress.repliedAt)} ago.`
      }
      return `${assistantName} finished preparing a reply.`
  }
}

export function serializeReplyProgress(id: string, progress: ReplyProgress): ReplyProgressSnapshot {
  return {
    id,
    ...progress,
  }
}
