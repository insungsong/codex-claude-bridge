import { describe, expect, test } from 'bun:test'

import {
  buildCodexAppServerArgs,
  buildCodexRemoteLaunchArgs,
  buildInitializeRequest,
  buildThreadResumeRequest,
  buildTurnStartRequest,
  selectTurnReply,
} from './codex-peer'

describe('codex peer app-server bridge', () => {
  test('builds remote Codex args that create the peer-owned thread with bridge MCP disabled', () => {
    const args = buildCodexRemoteLaunchArgs({
      wsUrl: 'ws://127.0.0.1:4510',
      roomId: 'test2',
    })

    expect(args).toEqual([
      '--remote', 'ws://127.0.0.1:4510',
      '-c', 'features.codex_hooks=false',
      '-c', 'mcp_servers.context7.enabled=false',
      '-c', 'mcp_servers.linear.enabled=false',
      '-c', 'mcp_servers.github.enabled=false',
      '-c', 'mcp_servers.openaiDeveloper.enabled=false',
      '-c', 'mcp_servers.insomnia.enabled=false',
      '-c', 'mcp_servers.codex-bridge.enabled=false',
      '-c', 'mcp_servers.omx_state.enabled=false',
      '-c', 'mcp_servers.omx_memory.enabled=false',
      '-c', 'mcp_servers.omx_code_intel.enabled=false',
      '-c', 'mcp_servers.omx_trace.enabled=false',
      '-m', 'gpt-5.4',
      'Bridge peer online for room test2. Briefly acknowledge readiness, then wait for further requests from this thread.',
    ])
  })

  test('builds minimized app-server args for the peer Codex runtime', () => {
    const args = buildCodexAppServerArgs({
      wsUrl: 'ws://127.0.0.1:4510',
      workingDirectory: '/tmp/workdir',
    })

    expect(args).toEqual([
      '-C', '/tmp/workdir',
      '-c', 'features.codex_hooks=false',
      '-c', 'mcp_servers.context7.enabled=false',
      '-c', 'mcp_servers.linear.enabled=false',
      '-c', 'mcp_servers.github.enabled=false',
      '-c', 'mcp_servers.openaiDeveloper.enabled=false',
      '-c', 'mcp_servers.insomnia.enabled=false',
      '-c', 'mcp_servers.codex-bridge.enabled=false',
      '-c', 'mcp_servers.omx_state.enabled=false',
      '-c', 'mcp_servers.omx_memory.enabled=false',
      '-c', 'mcp_servers.omx_code_intel.enabled=false',
      '-c', 'mcp_servers.omx_trace.enabled=false',
      'app-server',
      '--listen', 'ws://127.0.0.1:4510',
    ])
  })

  test('builds initialize, thread/resume, and turn/start requests for app-server', () => {
    expect(buildInitializeRequest(1)).toEqual({
      id: 1,
      method: 'initialize',
      params: {
        clientInfo: {
          name: 'codex-bridge',
          title: null,
          version: '0.4.0',
        },
        capabilities: {
          experimentalApi: true,
        },
      },
    })

    expect(buildThreadResumeRequest({
      id: 2,
      threadId: 'ignored-by-path',
      path: '/tmp/thread.jsonl',
    })).toEqual({
      id: 2,
      method: 'thread/resume',
      params: {
        threadId: 'ignored-by-path',
        path: '/tmp/thread.jsonl',
        persistExtendedHistory: false,
      },
    })

    expect(buildTurnStartRequest({
      id: 3,
      threadId: 'thr_123',
      message: 'Check fulfillment cardinality.',
    })).toEqual({
      id: 3,
      method: 'turn/start',
      params: {
        threadId: 'thr_123',
        input: [{
          type: 'text',
          text: 'Check fulfillment cardinality.',
          text_elements: [],
        }],
      },
    })
  })

  test('prefers final_answer agent messages and falls back to the latest completed text', () => {
    expect(selectTurnReply([
      { type: 'agentMessage', text: 'Thinking', phase: 'commentary' },
      { type: 'agentMessage', text: 'Done', phase: 'final_answer' },
    ])).toBe('Done')

    expect(selectTurnReply([
      { type: 'agentMessage', text: 'First', phase: null },
      { type: 'agentMessage', text: 'Second', phase: null },
    ])).toBe('Second')

    expect(selectTurnReply([
      { type: 'commandExecution', aggregatedOutput: 'ignored' },
    ])).toBeNull()
  })
})
