import { describe, expect, test } from 'bun:test'

import {
  applyThreadLifecycleEvent,
  buildPeerReadyPrompt,
  buildThreadStartRequest,
  buildCodexAppServerArgs,
  buildCodexRemoteLaunchArgs,
  CodexPeerBridge,
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
      'Bridge peer online for room test2. 첫 응답으로 정확히 "test2 준비됐습니다. 다음 요청을 기다리겠습니다."만 출력하고, 이후 이 thread에서 다음 요청을 기다리세요. 이후 non-trivial 요청은 leader Codex가 설계한 [Codex handoff]라고 가정하고 Role, Goal, Success criteria, Source context/evidence, Constraints, Task slice, Allowed tools/edits, Tool notes, Verification, Output, Stop rules 안에서만 수행하세요. 새 설계, scope 확대, dependency 추가, destructive command가 필요하면 실행하지 말고 BLOCKED로 보고하세요.',
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

    expect(buildThreadStartRequest({
      id: 4,
      workingDirectory: '/tmp/workdir',
    })).toEqual({
      id: 4,
      method: 'thread/start',
      params: {
        cwd: '/tmp/workdir',
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

  test('stages a replacement thread when a new peer thread starts before the old one closes', () => {
    const started = applyThreadLifecycleEvent({
      activeThreadId: 'thr-old',
      activeThreadPath: '/tmp/old.jsonl',
      stagedThreadId: '',
      stagedThreadPath: '',
    }, {
      type: 'started',
      threadId: 'thr-new',
      threadPath: '/tmp/new.jsonl',
    })

    expect(started.effect).toBe('stage-replacement')
    expect(started.state).toEqual({
      activeThreadId: 'thr-old',
      activeThreadPath: '/tmp/old.jsonl',
      stagedThreadId: 'thr-new',
      stagedThreadPath: '/tmp/new.jsonl',
    })

    const closed = applyThreadLifecycleEvent(started.state, {
      type: 'closed',
      threadId: 'thr-old',
    })

    expect(closed.effect).toBe('promote-staged')
    expect(closed.state).toEqual({
      activeThreadId: 'thr-new',
      activeThreadPath: '/tmp/new.jsonl',
      stagedThreadId: '',
      stagedThreadPath: '',
    })
  })

  test('clears the active thread when it closes without a staged replacement', () => {
    const closed = applyThreadLifecycleEvent({
      activeThreadId: 'thr-only',
      activeThreadPath: '/tmp/only.jsonl',
      stagedThreadId: '',
      stagedThreadPath: '',
    }, {
      type: 'closed',
      threadId: 'thr-only',
    })

    expect(closed.effect).toBe('clear-active')
    expect(closed.state).toEqual({
      activeThreadId: '',
      activeThreadPath: '',
      stagedThreadId: '',
      stagedThreadPath: '',
    })
  })

  test('recovers by starting a fresh thread when queued bridge work arrives after the active thread was cleared', async () => {
    const rpcRequests: Array<{ method: string; params: unknown }> = []
    const expectedWorkingDirectory = process.env.CODEX_BRIDGE_WORKDIR ?? process.cwd()
    const bridge = new CodexPeerBridge({
      roomId: 'ALL-RECOVER',
      bridgeToken: 'token',
      base: 'http://localhost:8788',
    }, async () => new Response(null, { status: 204 })) as any

    bridge.rpc = {
      request: async (method: string, params: unknown) => {
        rpcRequests.push({ method, params })
        if (method === 'thread/start') {
          return {
            thread: {
              id: 'thr-recovered',
              path: '/tmp/recovered.jsonl',
            },
          }
        }
        if (method === 'turn/start') {
          return { turn: { id: 'turn-1' } }
        }
        throw new Error(`unexpected rpc method: ${method}`)
      },
    }
    bridge.waitForBridgeTurnReply = async () => 'Recovered reply'
    bridge.sendReply = async () => {}

    bridge.bridgeQueue = [{ id: 'msg-1', text: 'resume work', sender: 'codex' }]
    bridge.threadId = ''
    bridge.threadPath = ''
    bridge.threadBusy = false
    bridge.bridgeProcessing = false

    await bridge.processBridgeQueue()

    expect(rpcRequests).toEqual([
      {
        method: 'thread/start',
        params: {
          cwd: expectedWorkingDirectory,
        },
      },
      {
        method: 'turn/start',
        params: {
          threadId: 'thr-recovered',
          input: [{
            type: 'text',
            text: 'resume work',
            text_elements: [],
          }],
        },
      },
    ])
    expect(bridge.threadId).toBe('thr-recovered')
    expect(bridge.threadPath).toBe('/tmp/recovered.jsonl')
  })

  test('adopts a peer-started replacement thread immediately when the bridge is idle and seeds the standby turn', async () => {
    const rpcRequests: Array<{ method: string; params: unknown }> = []
    const bridge = new CodexPeerBridge({
      roomId: 'ALL-4',
      bridgeToken: 'token',
      base: 'http://localhost:8788',
    }, async () => new Response(null, { status: 204 })) as any

    bridge.rpc = {
      request: async (method: string, params: unknown) => {
        rpcRequests.push({ method, params })
        if (method === 'turn/start') return { turn: { id: 'system-turn-1' } }
        throw new Error(`unexpected rpc method: ${method}`)
      },
    }
    bridge.threadId = 'thr-old'
    bridge.threadPath = '/tmp/old.jsonl'
    bridge.threadBusy = false

    await bridge.handleNotification({
      method: 'thread/started',
      params: {
        thread: {
          id: 'thr-new',
          path: '/tmp/new.jsonl',
        },
      },
    })

    expect(bridge.threadId).toBe('thr-new')
    expect(bridge.threadPath).toBe('/tmp/new.jsonl')
    expect(bridge.stagedThreadId).toBe('')
    expect(rpcRequests).toEqual([
      {
        method: 'turn/start',
        params: {
          threadId: 'thr-new',
          input: [{
            type: 'text',
            text: buildPeerReadyPrompt('ALL-4'),
            text_elements: [],
          }],
        },
      },
    ])
    expect(bridge.trackedTurns.get('system-turn-1')?.source).toBe('system')
  })
})
