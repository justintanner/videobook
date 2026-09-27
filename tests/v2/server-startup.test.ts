import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from '@dolthub/doltlite'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Result } from 'videobook-engine'
import { afterEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager'
import { callTool, startServer, stopServer } from './mcp-http-test-server'
import type { StartedServer } from './mcp-http-test-server'

function value<T>(result: Result<T, { message: string }>): T {
  if (!result.ok) throw new Error(result.error.message)
  return result.value
}

describe('server startup', () => {
  let rootDir: string | undefined
  const servers: StartedServer[] = []

  afterEach(async () => {
    await Promise.all(servers.splice(0).map(stopServer))
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  it.each([false, true])('opens the library after tagged image deletion with legacy leftovers=%s', async (legacy) => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-server-tag-deletion-'))
    const manager = new BookManager({ libraryDir: join(rootDir, 'books') })
    const book = value(await manager.create('tagged-deletion'))
    const managed = value(manager.get(book.bookId))
    let artifactId: string
    try {
      const engine = managed.engine
      artifactId = value(await engine.artifacts.create('image', 'Deleted image')).artifactId
      value(await engine.files.write(artifactId, 'original.png', 'image bytes'))
      const file = value(await engine.files.manifest(artifactId)).files[0]!
      value(await engine.tags.automatic.replace({
        artifactId, sourceHash: file.objectHash, generator: 'test', extractorVersion: '1',
        tags: [{ facet: 'places', label: 'Beach' }],
      }))
      value(await engine.tags.remove(artifactId, { facet: 'places', label: 'Beach' }))
      value(await engine.tags.add(artifactId, { facet: 'custom', label: 'Keep' }))
      if (!legacy) value(await engine.artifacts.delete(artifactId, { deleteOwnedMedia: true }))
    } finally {
      await manager.close()
    }
    if (legacy) {
      const db = new DatabaseSync(join(managed.rootDir, 'data', 'videobook.db'))
      try {
        db.exec('PRAGMA foreign_keys=ON')
        db.prepare('DELETE FROM artifacts WHERE artifact_id=?').run(artifactId)
        for (const table of ['artifacts', 'artifact_files']) {
          db.prepare('SELECT dolt_add(?) AS result').get(table)
        }
        db.prepare("SELECT dolt_commit('-m', 'delete_artifact with legacy write set') AS hash").get()
      } finally {
        db.close()
      }
    }
    const running = await startServer(rootDir)
    servers.push(running)
    const client = new Client({ name: 'startup-test', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    try {
      await client.connect(new StreamableHTTPClientTransport(new URL(running.url)))
      expect(await callTool(client, 'list_books', {})).toEqual([
        expect.objectContaining({ bookId: book.bookId, artifactCount: 0, notebookCount: 1 }),
      ])
      const health = await fetch(new URL('/healthz', running.url))
      expect(health.ok).toBe(true)
      expect(running.child.exitCode).toBeNull()
      expect(running.output.join('')).not.toContain('[startup-failed]')
    } finally {
      await client.close()
    }
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
