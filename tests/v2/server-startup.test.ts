import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { startServer, stopServer } from './mcp-http-test-server'
import type { StartedServer } from './mcp-http-test-server'

describe('server startup', () => {
  let rootDir: string | undefined
  const servers: StartedServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(stopServer))
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  it('rejects an occupied port before opening the library and keeps the existing server available', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-server-startup-'))
    const running = await startServer(join(rootDir, 'running'))
    servers.push(running)
    const port = new URL(running.url).port
    const libraryDir = join(rootDir, 'duplicate', 'books')
    const output: string[] = []
    const child = spawn(process.execPath, ['--import', 'tsx', 'server/src/index.ts'], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        B2_ACCESS_KEY_ID: '',
        B2_BUCKET: '',
        B2_ENDPOINT: '',
        B2_REGION: '',
        B2_SECRET_ACCESS_KEY: '',
        PORT: port,
        VIDEOBOOK_APP_STATE_PATH: join(rootDir, 'duplicate', 'app-state.json'),
        VIDEOBOOK_ARCHIVE_DIR: join(rootDir, 'duplicate', 'archive'),
        VIDEOBOOK_CATALOG_BACKUP_URL: '',
        VIDEOBOOK_CATALOG_BACKUP_URL_TEMPLATE: '',
        VIDEOBOOK_DEV_FIXTURES: '0',
        VIDEOBOOK_LIBRARY_DIR: libraryDir,
        VIDEOBOOK_LOG_LEVEL: 'info',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    servers.push({ child, output, url: running.url })
    child.stdout.on('data', (data: Buffer) => output.push(data.toString()))
    child.stderr.on('data', (data: Buffer) => output.push(data.toString()))

    const [exitCode, signal] = await once(child, 'close')
    expect({ exitCode, signal }).toEqual({ exitCode: 1, signal: null })
    const log = output.join('')
    expect(log).toContain('[startup-failed]')
    expect(log).toContain('"errorCode":"EADDRINUSE"')
    expect(log).toContain(`"port":${port}`)
    expect(log).not.toContain('MCP server listening')
    expect(log).not.toContain('[book-open]')
    await expect(access(libraryDir)).rejects.toMatchObject({ code: 'ENOENT' })

    const health = await fetch(new URL('/healthz', running.url))
    expect(health.ok).toBe(true)
    expect(await health.json()).toMatchObject({ ok: true, service: 'videobook' })
    expect((await fetch(running.url)).status).toBe(405)
  })
})
