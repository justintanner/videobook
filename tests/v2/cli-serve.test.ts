import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { availablePort } from './e2e-harness.js'
import { callTool } from './mcp-http-test-server.js'
import { cleanupCli, cliEnv, connectMcp, runCli, spawnCli, stopCli, tempDir, waitForHealth } from './cli-harness.js'

const SERVER_VERSION = (createRequire(import.meta.url)('../../server/package.json') as { version: string }).version
const LOCK_FILE = '.videobook-server.json'

async function uiFixture(root: string): Promise<string> {
  const uiDir = join(root, 'ui')
  await mkdir(join(uiDir, 'assets'), { recursive: true })
  await writeFile(join(uiDir, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/assets/app-abc.js"></script></body></html>')
  await writeFile(join(uiDir, 'assets', 'app-abc.js'), 'export {}\n')
  return uiDir
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
  const pid = child.pid ?? 0
  await once(child, 'exit')
  return pid
}

function html(url: string): Promise<Response> {
  return fetch(url, { headers: { accept: 'text/html' } })
}

describe('videobook serve', () => {
  afterEach(cleanupCli)

  it('serves the web UI, MCP and health from one loopback port and owns the library', async () => {
    const root = await tempDir()
    const home = join(root, 'home')
    const port = await availablePort()
    const base = `http://127.0.0.1:${port}`
    const env = cliEnv({ VIDEOBOOK_UI_DIR: await uiFixture(root) })
    const cli = spawnCli(['serve', '--port', String(port), '--home', home], env)

    expect(await waitForHealth(base, cli)).toMatchObject({ ok: true, service: 'videobook', version: SERVER_VERSION })
    const shell = await html(`${base}/`)
    expect(shell.status).toBe(200)
    expect(shell.headers.get('cache-control')).toBe('no-cache')
    expect(await shell.text()).toContain('<div id="root"></div>')
    expect(await (await html(`${base}/jobs`)).text()).toContain('<div id="root"></div>')
    const asset = await fetch(`${base}/assets/app-abc.js`)
    expect(asset.status).toBe(200)
    expect(asset.headers.get('cache-control')).toContain('immutable')
    expect((await fetch(`${base}/missing`, { headers: { accept: 'application/json' } })).status).toBe(404)
    expect((await html(`${base}/api/unknown`)).status).toBe(404)

    const client = await connectMcp(`${base}/mcp`)
    try {
      const created = await callTool<{ bookId: string }>(client, 'create_book', { name: 'cli-serve' })
      expect(await callTool<Array<{ bookId: string }>>(client, 'list_books', {}))
        .toEqual([expect.objectContaining({ bookId: created.bookId })])
    } finally {
      await client.close()
    }

    expect(cli.stdout.join('')).toContain(`UI       ${base}/`)
    expect(cli.stdout.join('')).toContain(`Library  ${join(home, 'books')}`)
    const lock = JSON.parse(await readFile(join(home, 'books', LOCK_FILE), 'utf8')) as Record<string, unknown>
    expect(lock).toMatchObject({ pid: cli.child.pid, port, url: base, version: SERVER_VERSION })

    const second = await runCli(['serve', '--port', String(await availablePort()), '--home', home], env)
    expect(second.code).toBe(1)
    expect(second.stderr).toContain(`videobook is already running at ${base} (pid ${cli.child.pid})`)
    expect((await fetch(`${base}/healthz`)).ok).toBe(true)

    expect(await stopCli(cli)).toBe(0)
    expect(cli.output()).toContain('[shutdown-complete]')
    await expect(access(join(home, 'books', LOCK_FILE))).rejects.toMatchObject({ code: 'ENOENT' })
  }, 120_000)

  it('runs headless with MCP and no web UI', async () => {
    const root = await tempDir()
    const port = await availablePort()
    const base = `http://127.0.0.1:${port}`
    const cli = spawnCli(['serve', '--headless', '--port', String(port), '--home', join(root, 'home')],
      cliEnv({ VIDEOBOOK_UI_DIR: await uiFixture(root) }))

    await waitForHealth(base, cli)
    expect((await html(`${base}/`)).status).toBe(404)
    expect(cli.stdout.join('')).toContain('UI       off (--headless)')
    expect(await stopCli(cli)).toBe(0)
  }, 60_000)

  it('takes over a lock left behind by a process that died', async () => {
    const root = await tempDir()
    const home = join(root, 'home')
    await mkdir(join(home, 'books'), { recursive: true })
    await writeFile(join(home, 'books', LOCK_FILE), JSON.stringify({ pid: await deadPid(), port: 1, url: 'http://127.0.0.1:1', startedAt: 'old', version: '0' }))
    const port = await availablePort()
    const cli = spawnCli(['serve', '--headless', '--port', String(port), '--home', home])

    await waitForHealth(`http://127.0.0.1:${port}`, cli)
    expect(JSON.parse(await readFile(join(home, 'books', LOCK_FILE), 'utf8'))).toMatchObject({ pid: cli.child.pid, port })
    expect(await stopCli(cli)).toBe(0)
  }, 60_000)

  it('explains a busy port without creating the library', async () => {
    const root = await tempDir()
    const home = join(root, 'home')
    const blocker = createServer()
    blocker.listen(0, '127.0.0.1')
    await once(blocker, 'listening')
    const address = blocker.address()
    const port = address && typeof address !== 'string' ? address.port : 0
    try {
      const result = await runCli(['serve', '--port', String(port), '--home', home])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain(`Port ${port} is already in use by another process; pass --port <n>.`)
      expect(`${result.stdout}${result.stderr}`).toContain('"errorCode":"EADDRINUSE"')
      await expect(access(join(home, 'books'))).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await new Promise<void>((resolveClose) => blocker.close(() => resolveClose()))
    }
  }, 60_000)
})
