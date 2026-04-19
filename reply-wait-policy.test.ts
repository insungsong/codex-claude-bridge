import { describe, expect, test } from 'bun:test'

import { shouldKeepWaitingForReply } from './reply-wait-policy'

describe('reply wait policy', () => {
  test('keeps waiting during the base window even without progress', () => {
    expect(shouldKeepWaitingForReply(0, null, 100_000)).toBe(true)
  })

  test('stops waiting after the base window if no assistant progress exists', () => {
    expect(shouldKeepWaitingForReply(0, null, 150_000)).toBe(false)
  })

  test('keeps waiting beyond the base window when assistant progress is fresh', () => {
    expect(shouldKeepWaitingForReply(0, {
      id: 'msg-1',
      state: 'in_progress',
      createdAt: 0,
      deliveredAt: 20_000,
      lastProgressAt: 140_000,
      progressNote: 'still thinking',
    }, 150_000)).toBe(true)
  })

  test('stops waiting when assistant progress is stale', () => {
    expect(shouldKeepWaitingForReply(0, {
      id: 'msg-1',
      state: 'in_progress',
      createdAt: 0,
      deliveredAt: 20_000,
      lastProgressAt: 1_000,
      progressNote: 'old progress',
    }, 150_000)).toBe(false)
  })

  test('stops waiting once the maximum window is exhausted', () => {
    expect(shouldKeepWaitingForReply(0, {
      id: 'msg-1',
      state: 'in_progress',
      createdAt: 0,
      deliveredAt: 20_000,
      lastProgressAt: 599_000,
      progressNote: 'recent progress',
    }, 601_000)).toBe(false)
  })
})
