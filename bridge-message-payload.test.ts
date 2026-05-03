import { describe, expect, test } from 'bun:test'

import {
  normalizeBridgeMessage,
  validateBridgeTextPayload,
} from './bridge-message-payload'

describe('bridge message payload', () => {
  test('normalizes whitespace for dedupe keys', () => {
    expect(normalizeBridgeMessage('  hello   bridge  world  ')).toBe('hello bridge world')
  })

  test.each([
    ['', 'empty'],
    ['   ', 'empty'],
    ['{{ARGUMENTS}}', 'placeholder-only'],
    [' "$send-to-claude" ', 'placeholder-only'],
    [' "$send-to-codex" ', 'placeholder-only'],
    ['Task:', 'placeholder-only'],
    ['Task: {{ARGUMENTS}}', 'placeholder-only'],
    ['   `Task:`   ', 'placeholder-only'],
  ] as const)('rejects invalid payload %p', (input, reason) => {
    expect(validateBridgeTextPayload(input)).toEqual({
      ok: false,
      reason,
      error:
        reason === 'empty'
          ? 'message must be a non-empty string'
          : 'message must include real text, not an empty or placeholder-only payload',
    })
  })

  test('accepts real relay text even when wrapped in quotes', () => {
    expect(validateBridgeTextPayload('  "안녕하세요 Claude"  ')).toEqual({
      ok: true,
      text: '"안녕하세요 Claude"',
      normalized: '"안녕하세요 Claude"',
    })
  })

  test('accepts task-prefixed payload when it includes real content', () => {
    expect(validateBridgeTextPayload('Task: verify ENG-2436 implementation')).toEqual({
      ok: true,
      text: 'Task: verify ENG-2436 implementation',
      normalized: 'Task: verify ENG-2436 implementation',
    })
  })
})
