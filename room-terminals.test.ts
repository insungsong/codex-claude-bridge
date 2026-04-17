import { describe, expect, test } from 'bun:test'

import { getTerminalSessions, shutdownRoomTerminals } from './room-terminals'

function createDeps({
  files,
  alivePids,
  onKill,
}: {
  files: Record<string, string>
  alivePids: Set<number>
  onKill?: (pid: number, signal?: NodeJS.Signals | 0) => void
}) {
  return {
    tmpDir: '/tmp',
    readdirSync: () => Object.keys(files),
    readFileSync: (path: string) => {
      const file = path.replace('/tmp/', '')
      if (!(file in files)) throw new Error(`missing file: ${file}`)
      return files[file]
    },
    unlinkSync: (path: string) => {
      delete files[path.replace('/tmp/', '')]
    },
    kill: (pid: number, signal?: NodeJS.Signals | 0) => {
      if (signal === 0) {
        if (!alivePids.has(pid)) throw new Error('ESRCH')
        return
      }
      if (!alivePids.has(pid)) throw new Error('ESRCH')
      onKill?.(pid, signal)
    },
    sleep: async () => {},
  }
}

describe('room terminals', () => {
  test('groups only live bridge sessions by room and agent', () => {
    const files = {
      'claude-bridge-room-101': 'ENG-2405',
      'codex-bridge-room-202': 'ENG-2405:token',
      'claude-bridge-room-303': 'ENG-2436',
      'not-a-room-file': 'ignore-me',
    }
    const deps = createDeps({
      files,
      alivePids: new Set([101, 202]),
    })

    const sessions = getTerminalSessions(deps)

    expect(sessions.get('ENG-2405')).toEqual({ claude: [101], codex: [202] })
    expect(sessions.has('ENG-2436')).toBe(false)
  })

  test('terminates only the selected room and escalates to SIGKILL when needed', async () => {
    const files = {
      'claude-bridge-room-101': 'ENG-2405',
      'codex-bridge-room-202': 'ENG-2405',
      'claude-bridge-room-303': 'ENG-2436',
    }
    const alivePids = new Set([101, 202, 303])
    const kills: Array<[number, NodeJS.Signals | 0 | undefined]> = []
    const deps = createDeps({
      files,
      alivePids,
      onKill: (pid, signal) => {
        kills.push([pid, signal])
        if (pid === 101 && signal === 'SIGTERM') alivePids.delete(pid)
        if (pid === 202 && signal === 'SIGKILL') alivePids.delete(pid)
      },
    })

    const summary = await shutdownRoomTerminals('ENG-2405', deps)

    expect(kills).toEqual([
      [101, 'SIGTERM'],
      [202, 'SIGTERM'],
      [202, 'SIGKILL'],
    ])
    expect(summary).toEqual({
      roomId: 'ENG-2405',
      matched: 2,
      terminated: [101],
      forced: [202],
      cleanedPidFiles: [
        '/tmp/claude-bridge-room-101',
        '/tmp/codex-bridge-room-202',
      ],
      failures: [],
    })
    expect(alivePids.has(303)).toBe(true)
    expect(files['claude-bridge-room-303']).toBe('ENG-2436')
  })
})
