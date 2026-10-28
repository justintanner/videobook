import { chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { cleanupCli, cliEnv, runCli, tempDir } from './cli-harness.js'
import { testBudget } from '../../server/src/test-budget.js'

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
      'node', 'data-home', 'har-capture', 'library', 'ffmpeg', 'ffprobe', 'yt-dlp', 'native-runtime', 'search-runtime', 'render-browser', 'one-password', 'provider-keys', 'owner',
    ])
    const byId = new Map(report.checks.map((check) => [check.id, check]))
    expect(byId.get('data-home')?.detail).toContain(`${home} (VIDEOBOOK_HOME)`)
    expect(byId.get('library')?.detail).toContain(join(home, 'books'))
    expect(byId.get('har-capture')?.detail).toContain(`off; ${join(home, 'har')}; writable: yes`)
    expect(byId.get('native-runtime')?.status).toBe('ok')
    expect(byId.get('one-password')?.detail).toContain('not used')
    expect(byId.get('provider-keys')?.status).toBe('warn')
    expect(byId.get('owner')?.detail).toContain('not running')
  }, testBudget(60_000))

  it('reports a 1Password reference it cannot resolve and does not use it as a key', async () => {
    const home = join(await tempDir(), 'home')
    await mkdir(home, { recursive: true })
    await writeFile(join(home, '.env'), "FAL_API_KEY='op://Example/FAL_API_KEY/pass{{word}}'\n", { mode: 0o600 })
    const result = await runCli(['doctor', '--json', '--home', home])
    expect(result.code, result.stdout + result.stderr).toBe(0)
    const report = JSON.parse(result.stdout) as { checks: DoctorCheck[] }
    const byId = new Map(report.checks.map((check) => [check.id, check]))
    expect(byId.get('one-password')?.status).toBe('warn')
    expect(byId.get('one-password')?.detail).toContain('FAL_API_KEY from op://Example/FAL_API_KEY/pass{{word}} (malformed op:// reference)')
    expect(byId.get('provider-keys')?.detail).not.toContain('FAL_API_KEY (')
  }, testBudget(60_000))

  it('reports yt-dlp impersonation targets and the cookies file path without its contents', async () => {
    const dir = await tempDir()
    const home = join(dir, 'home')
    const ytdlp = join(dir, 'yt-dlp')
    await writeFile(ytdlp, [
      '#!/bin/sh',
      "printf '%s\\n' '[info] Available impersonate targets' 'Client          OS           Source' '--------------------------------------'",
      "printf '%s\\n' 'Chrome-136      Macos-15     curl_cffi' 'Safari-18.0     Ios-18.0     curl_cffi' 'Firefox         -            curl_cffi>=0.10 (unavailable)'",
      '',
    ].join('\n'))
    await chmod(ytdlp, 0o755)
    const cookies = join(dir, 'cookies.txt')
    await writeFile(cookies, '# Netscape HTTP Cookie File\n.tiktok.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tsecret-session\n')

    const configured = await runCli(['doctor', '--json', '--home', home], cliEnv({ VIDEOBOOK_YTDLP_PATH: ytdlp, VIDEOBOOK_YTDLP_COOKIES: cookies }))
    expect(configured.code, configured.stdout + configured.stderr).toBe(0)
    const row = (JSON.parse(configured.stdout) as { checks: DoctorCheck[] }).checks.find((check) => check.id === 'yt-dlp')
    expect(row).toMatchObject({ status: 'ok', detail: `${ytdlp} (VIDEOBOOK_YTDLP_PATH); impersonation: chrome, safari; cookies: ${cookies}` })
    expect(configured.stdout + configured.stderr).not.toContain('secret-session')

    const missing = join(dir, 'missing-cookies.txt')
    const unreadable = await runCli(['doctor', '--home', home], cliEnv({ VIDEOBOOK_YTDLP_PATH: join(dir, 'no-yt-dlp'), VIDEOBOOK_YTDLP_COOKIES: missing }))
    expect(unreadable.code, unreadable.stdout + unreadable.stderr).toBe(0)
    expect(unreadable.stdout).toMatch(/warn\s+yt-dlp\s+.*no-yt-dlp \(VIDEOBOOK_YTDLP_PATH\); impersonation: none; cookies: .*missing-cookies\.txt \(not readable\)/u)
    expect(unreadable.stdout).toContain('fix: Point VIDEOBOOK_YTDLP_COOKIES at a readable Netscape cookies file, or unset it.')
  }, testBudget(60_000))

  it('fails with the install remedy when ffmpeg cannot run', async () => {
    const home = join(await tempDir(), 'home')
    const result = await runCli(['doctor', '--home', home], cliEnv({ VIDEOBOOK_FFMPEG_PATH: '/nonexistent/ffmpeg' }))
    expect(result.code).toBe(1)
    expect(result.stdout).toMatch(/FAIL\s+ffmpeg\s+\/nonexistent\/ffmpeg did not run/u)
    expect(result.stdout).toContain('npm install -g videobook --allow-scripts=ffmpeg-static,ytdlp-nodejs,@dolthub/doltlite,usearch,onnxruntime-node,esbuild')
  }, testBudget(60_000))
})
