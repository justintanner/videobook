import { existsSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:http'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { createHarCapture, type Har } from '@apicity/har'
import { cleanupCli, runCli, tempDir } from './cli-harness.js'
import { testBudget } from '../../server/src/test-budget.js'

interface IndexRow {
  ts: string
  provider: string
  outcome: string
  file: string
}

describe('videobook har', () => {
  let server: Server
  let url: string

  beforeAll(async () => {
    server = createServer((req, res) => {
      req.resume()
      req.on('end', () => {
        res.setHeader('content-type', 'application/json')
        res.statusCode = req.url === '/fail' ? 400 : 200
        res.end(JSON.stringify(req.url === '/fail' ? { msg: 'aspect_ratio is invalid' } : { data: { taskId: 'task-1' } }))
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('No address')
    url = `http://127.0.0.1:${address.port}`
  })

  afterAll(async () => {
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  afterEach(cleanupCli)

  async function seededHome(): Promise<string> {
    const home = await tempDir('videobook-har-cli-')
    const calls = [
      { provider: 'kie', path: '/ok', at: '2026-10-20T08:00:00.000Z' },
      { provider: 'fal', path: '/fail', at: '2026-10-21T08:00:00.000Z' },
    ]
    for (const call of calls) {
      const capture = createHarCapture({ dir: join(home, 'har'), mode: 'all', clock: () => Date.parse(call.at) })
      await capture.call({ provider: call.provider, endpoint: 'post.api.v1.jobs.createTask', input: { prompt: 'a heron' } }, async () => {
        const response = await capture.fetch(`${url}${call.path}`, {
          method: 'POST',
          headers: { authorization: 'Bearer sk-live-secret-123' },
          body: JSON.stringify({ prompt: 'a heron' }),
        })
        await response.text()
        if (!response.ok) throw Object.assign(new Error('aspect_ratio is invalid'), { status: response.status })
      }).catch(() => undefined)
      await capture.close()
    }
    return home
  }

  it('lists captures newest first and filters failures', async () => {
    const home = await seededHome()
    const listed = await runCli(['har', 'list', '--home', home])
    expect(listed.code, listed.stderr).toBe(0)
    const lines = listed.stdout.trim().split('\n')
    expect(lines[0]).toBe('ts\tprovider\tendpoint\toutcome\tstatus\tfile')
    expect(lines.slice(1).map((line) => line.split('\t').slice(0, 5))).toEqual([
      ['2026-10-21T08:00:00.000Z', 'fal', 'post.api.v1.jobs.createTask', 'provider_error', '400'],
      ['2026-10-20T08:00:00.000Z', 'kie', 'post.api.v1.jobs.createTask', 'ok', '200'],
    ])

    const failures = await runCli(['har', 'list', '--failures', '--json', '--home', home])
    expect(failures.code, failures.stderr).toBe(0)
    const parsed = JSON.parse(failures.stdout) as { dir: string; captures: IndexRow[] }
    expect(parsed.dir).toBe(join(home, 'har'))
    expect(parsed.captures.map((row) => row.provider)).toEqual(['fal'])
  }, testBudget(60_000))

  it('exports scrub-checked captures with a manifest and prints the apicity hand-off', async () => {
    const home = await seededHome()
    const out = join(home, 'shared', 'captures')
    const exported = await runCli(['har', 'export', '--out', out, '--home', home])
    expect(exported.code, exported.stderr).toBe(0)
    expect(exported.stdout).toContain(`Exported 2 captures (2026-10-20T08:00:00.000Z to 2026-10-21T08:00:00.000Z) to ${out}`)
    expect(exported.stdout).toContain(`apicity har report ${out} > report.md`)
    expect(exported.stdout).toContain('pnpm run har:promote -- <capture.har>')
    const manifest = JSON.parse(await readFile(join(out, 'manifest.json'), 'utf8')) as { files: number; outcomes: Record<string, number> }
    expect(manifest.files).toBe(2)
    expect(manifest.outcomes).toMatchObject({ ok: 1, provider_error: 1 })

    const archive = join(home, 'shared', 'failures.tar.gz')
    const failures = await runCli(['har', 'export', '--out', archive, '--failures', '--provider', 'fal,kie', '--json', '--home', home])
    expect(failures.code, failures.stderr).toBe(0)
    const result = JSON.parse(failures.stdout) as { out: string; archive: boolean; manifest: { files: number; filters: unknown } }
    expect(result).toMatchObject({ out: archive, archive: true, manifest: { files: 1, filters: { since: null, failures: true, providers: ['fal', 'kie'] } } })
    expect(existsSync(archive)).toBe(true)
  }, testBudget(60_000))

  it('refuses to export when a capture would change under scrubHar', async () => {
    const home = await seededHome()
    const index = await readFile(join(home, 'har', 'index.jsonl'), 'utf8')
    const row = JSON.parse(index.split('\n')[0] ?? '{}') as IndexRow
    const planted = join(home, 'har', row.file)
    const har = JSON.parse(await readFile(planted, 'utf8')) as Har
    har.log.entries[0]?.request.headers.push({ name: 'x-api-key', value: 'sk-planted-secret' })
    await writeFile(planted, JSON.stringify(har))

    const out = join(home, 'refused')
    const refused = await runCli(['har', 'export', '--out', out, '--home', home])
    expect(refused.code).toBe(1)
    expect(refused.stderr).toContain('Refusing to export')
    expect(refused.stderr).toContain(planted)
    expect(refused.stdout).toBe('')
    expect(existsSync(out)).toBe(false)
  }, testBudget(60_000))

  it('reports usage errors', async () => {
    const home = await tempDir('videobook-har-cli-')
    for (const args of [
      ['har', 'export'],
      ['har', 'frob'],
      ['har', 'list', '--since', 'last-week'],
      ['har', 'list', '--out', join(home, 'x')],
    ]) {
      const result = await runCli([...args, '--home', home])
      expect(result.code, args.join(' ')).toBe(2)
      expect(result.stderr).toContain('Usage: videobook')
    }
    const inside = await runCli(['har', 'export', '--out', join(home, 'har', 'export'), '--home', home])
    expect(inside.code).toBe(2)
    expect(inside.stderr).toContain('--out must be outside the capture directory')
    const empty = await runCli(['har', 'export', '--out', join(home, 'export'), '--home', home])
    expect(empty.code).toBe(1)
    expect(empty.stderr).toContain('No captures in')
  }, testBudget(60_000))
})
