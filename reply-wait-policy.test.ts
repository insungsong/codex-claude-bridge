import { describe, expect, test } from 'bun:test'

import { shouldKeepWaitingForReply } from './reply-wait-policy'

describe('reply wait policy', () => {
  test('keeps waiting during the base window even without progress', () => {
    expect(shouldKeepWaitingForReply(0, null, 100_000)).toBe(true)
  })

  test('stops waiting after the base window if no status and peer is unknown', () => {
    expect(shouldKeepWaitingForReply(0, null, 150_000)).toBe(false)
  })

  test('stops waiting after the base window when no status even if peer is alive', () => {
    expect(shouldKeepWaitingForReply(0, null, 150_000, undefined, true)).toBe(false)
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

  test('stops waiting when assistant progress is stale and peer is not confirmed alive', () => {
    expect(shouldKeepWaitingForReply(0, {
      id: 'msg-1',
      state: 'in_progress',
      createdAt: 0,
      deliveredAt: 20_000,
      lastProgressAt: 1_000,
      progressNote: 'old progress',
    }, 150_000)).toBe(false)
  })

  test('stops waiting when progress is stale even if peer is still connected', () => {
    expect(shouldKeepWaitingForReply(0, {
      id: 'msg-1',
      state: 'in_progress',
      createdAt: 0,
      deliveredAt: 20_000,
      lastProgressAt: 1_000,
      progressNote: 'old progress',
    }, 400_000, undefined, true)).toBe(false)
  })

  test('stops waiting when state is only delivered and activity is stale', () => {
    expect(shouldKeepWaitingForReply(0, {
      id: 'msg-1',
      state: 'delivered',
      createdAt: 0,
      deliveredAt: 1_000,
    }, 500_000, undefined, true)).toBe(false)
  })

  test('stops waiting when a delivered request is not claimed within the claim window', () => {
    expect(shouldKeepWaitingForReply(0, {
      id: 'msg-1',
      state: 'delivered',
      createdAt: 0,
      deliveredAt: 10_000,
    }, 50_001, undefined, true)).toBe(false)
  })

  test('keeps waiting briefly when state is only delivered and activity is fresh', () => {
    expect(shouldKeepWaitingForReply(0, {
      id: 'msg-1',
      state: 'delivered',
      createdAt: 0,
      deliveredAt: 125_000,
    }, 150_000, undefined, true)).toBe(true)
  })

  test('stops waiting once the maximum window is exhausted even with a live peer', () => {
    expect(shouldKeepWaitingForReply(0, {
      id: 'msg-1',
      state: 'in_progress',
      createdAt: 0,
      deliveredAt: 20_000,
      lastProgressAt: 599_000,
      progressNote: 'recent progress',
    }, 601_000, undefined, true)).toBe(false)
  })

  test('queued state waits only while peer is alive and bridge activity is fresh', () => {
    const queued = {
      id: 'msg-1',
      state: 'queued' as const,
      createdAt: 0,
    }
    expect(shouldKeepWaitingForReply(0, queued, 115_000, undefined, false)).toBe(false)
    expect(shouldKeepWaitingForReply(0, queued, 115_000, undefined, true)).toBe(true)
    expect(shouldKeepWaitingForReply(0, queued, 150_000, undefined, true)).toBe(false)
  })
})
