import { describe, expect, test } from 'bun:test'
import { spawn } from 'node:child_process'

function runShell(script: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
    const proc = spawn('sh', ['-lc', script], {
      cwd: '/Users/SONGINSUNG/Documents/codex-claude-bridge',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    proc.stdout.on('data', chunk => { stdout += String(chunk) })
    proc.stderr.on('data', chunk => { stderr += String(chunk) })
    proc.once('exit', code => resolve({ code, stdout, stderr }))
  })
}

describe('bridge shell helpers', () => {
  test('resolves the current git repo root as CODEX_BRIDGE_WORKDIR', async () => {
    const result = await runShell('. ./bridge-common.sh; unset CODEX_BRIDGE_WORKDIR; bridge_resolve_workdir; printf \"%s\" \"$CODEX_BRIDGE_WORKDIR\"')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('/Users/SONGINSUNG/Documents/codex-claude-bridge')
  })

  test('fails fast outside a git repo when no explicit workdir is provided', async () => {
    const result = await runShell('cd /tmp; . /Users/SONGINSUNG/Documents/codex-claude-bridge/bridge-common.sh; unset CODEX_BRIDGE_WORKDIR; bridge_resolve_workdir')
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('run this inside the target git repository')
  })

  test('treats localhost bridge URLs as auto-start candidates', async () => {
    const result = await runShell('. ./bridge-common.sh; BRIDGE_URL=http://127.0.0.1:8788; if bridge_is_local_url; then echo yes; else echo no; fi')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('yes')
  })

  test('derives CODEX_BRIDGE_PORT from local bridge URLs before server start', async () => {
    const result = await runShell('. ./bridge-common.sh; BRIDGE_URL=http://127.0.0.1:24890; bridge_export_local_server_env; printf \"%s\" \"$CODEX_BRIDGE_PORT\"')
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toBe('24890')
  })
})
