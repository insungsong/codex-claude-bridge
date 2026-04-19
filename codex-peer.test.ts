import { describe, expect, test } from 'bun:test'

import { buildCodexExecArgs, buildCodexPeerPrompt } from './codex-peer'

describe('codex peer runner', () => {
  test('disables the bridge MCP when invoking codex exec', () => {
    const args = buildCodexExecArgs({
      prompt: 'Reply with OK only.',
      outputFile: '/tmp/codex-peer-output.txt',
      workingDirectory: '/tmp/example-room',
    })

    expect(args).toEqual([
      'exec',
      '--full-auto',
      '-C', '/tmp/example-room',
      '-c', 'mcp_servers.codex-bridge.enabled=false',
      '-o', '/tmp/codex-peer-output.txt',
      'Reply with OK only.',
    ])
  })

  test('builds a bounded worker prompt from the incoming bridge message', () => {
    const prompt = buildCodexPeerPrompt({
      roomId: 'ENG-9999',
      messageId: 'codex-123',
      message: 'Compare Redis and Memcached for this repo.',
    })

    expect(prompt).toContain('room ENG-9999')
    expect(prompt).toContain('message codex-123')
    expect(prompt).toContain('Compare Redis and Memcached for this repo.')
    expect(prompt).toContain('Respond with the final reply text only')
  })
})
