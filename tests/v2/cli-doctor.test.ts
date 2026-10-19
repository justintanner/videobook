import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupCli, cliEnv, runCli, tempDir } from './cli-harness.js'

interface DoctorCheck {
  id: string
  status: 'ok' | 'warn' | 'fail'
  detail: string
  remedy?: string
  required: boolean
}

describe('videobook doctor', () => {
  afterEach(cleanupCli)

  it('checks the environment and reports machine-readable results', async () => {
    const home = join(await tempDir(), 'home')
    const result = await runCli(['doctor', '--json', '--home', home])
    expect(result.code, result.stdout + result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as { ok: boolean; checks: DoctorCheck[] }
    expect(report.ok).toBe(true)
    expect(report.checks.map((check) => check.id)).toEqual([
      'node', 'data-home', 'library', 'ffmpeg', 'ffprobe', 'yt-dlp', 'native-runtime', 'search-runtime', 'render-browser', 'provider-keys', 'owner',
    ])
    const byId = new Map(report.checks.map((check) => [check.id, check]))
    expect(byId.get('data-home')?.detail).toContain(`${home} (VIDEOBOOK_HOME)`)
    expect(byId.get('library')?.detail).toContain(join(home, 'books'))
    expect(byId.get('native-runtime')?.status).toBe('ok')
    expect(byId.get('provider-keys')?.status).toBe('warn')
    expect(byId.get('owner')?.detail).toContain('not running')
  }, 60_000)

  it('fails with the install remedy when ffmpeg cannot run', async () => {
    const home = join(await tempDir(), 'home')
    const result = await runCli(['doctor', '--home', home], cliEnv({ VIDEOBOOK_FFMPEG_PATH: '/nonexistent/ffmpeg' }))
    expect(result.code).toBe(1)
    expect(result.stdout).toMatch(/FAIL\s+ffmpeg\s+\/nonexistent\/ffmpeg did not run/u)
    expect(result.stdout).toContain('npm install -g videobook --allow-scripts=ffmpeg-static,ytdlp-nodejs,@dolthub/doltlite,usearch,onnxruntime-node,esbuild')
  }, 60_000)
})
