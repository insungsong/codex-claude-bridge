import { describe, expect, test } from 'bun:test'

import {
  createReplyProgress,
  formatReplyProgressStatus,
  markReplyCompleted,
  markReplyDelivered,
  markReplyInProgress,
  serializeReplyProgress,
} from './bridge-reply-progress'

describe('bridge reply progress', () => {
  test('tracks queued to replied lifecycle', () => {
    const progress = createReplyProgress(1_000)

    expect(progress).toEqual({
      state: 'queued',
      createdAt: 1_000,
    })

    markReplyDelivered(progress, 2_000)
    expect(progress).toEqual({
      state: 'delivered',
      createdAt: 1_000,
      deliveredAt: 2_000,
    })

    markReplyInProgress(progress, 'Investigating multi-file change', 5_000)
    expect(progress).toEqual({
      state: 'in_progress',
      createdAt: 1_000,
      deliveredAt: 2_000,
      lastProgressAt: 5_000,
      progressNote: 'Investigating multi-file change',
    })

    markReplyCompleted(progress, 8_000)
    expect(progress).toEqual({
      state: 'replied',
      createdAt: 1_000,
      deliveredAt: 2_000,
      lastProgressAt: 5_000,
      progressNote: 'Investigating multi-file change',
      repliedAt: 8_000,
    })
  })

  test('formats useful status summaries', () => {
    const queued = createReplyProgress(1_000)
    expect(formatReplyProgressStatus(queued, 20_000)).toBe(
      'The bridge has not observed Claude receive or claim the request yet.',
    )

    markReplyDelivered(queued, 2_000)
    expect(formatReplyProgressStatus(queued, 20_000)).toBe(
      'Claude received the request 18s ago, but has not reported active progress yet.',
    )

    markReplyInProgress(queued, 'Running tests', 15_000)
    expect(formatReplyProgressStatus(queued, 20_000)).toBe(
      'Claude is still working on the request (last progress 5s ago) — Running tests.',
    )
  })

  test('formats status summaries for codex peer rooms', () => {
    const progress = createReplyProgress(1_000)
    markReplyDelivered(progress, 2_000)

    expect(formatReplyProgressStatus(progress, 20_000, 'Codex peer')).toBe(
      'Codex peer received the request 18s ago, but has not reported active progress yet.',
    )
  })

  test('serializes reply status snapshots for transport', () => {
    const progress = createReplyProgress(1_000)
    markReplyDelivered(progress, 2_000)

    expect(serializeReplyProgress('codex-123', progress)).toEqual({
      id: 'codex-123',
      state: 'delivered',
      createdAt: 1_000,
      deliveredAt: 2_000,
    })
  })
})
