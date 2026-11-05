import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { BOOK_AUTOMATION_PAUSED_KEY, type BookArchiveResult } from 'videobook-engine'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { testBudget } from '../../server/src/test-budget.js'
import { startServer, stopServer, callTool, type StartedServer } from './mcp-http-test-server.js'

const exec = promisify(execFile)
const roots: string[] = []
const servers: StartedServer[] = []
const clients: Client[] = []

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()))
  await Promise.all(servers.splice(0).map(stopServer))
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 3 })))
})

async function root() {
  const path = await mkdtemp(join(tmpdir(), 'videobook-portable-'))
  roots.push(path)
  return path
}

async function seed(path: string) {
  const books = new BookManager({ libraryDir: join(path, 'books') })
  try {
    const created = await books.create('portable-pig')
    if (!created.ok) throw new Error(created.error.message)
    const selected = books.get(created.value.bookId)
    if (!selected.ok) throw new Error(selected.error.message)
    const engine = selected.value.engine
    const artifact = await engine.artifacts.create('image', 'Portable picture')
    if (!artifact.ok) throw new Error(artifact.error.message)
    const red = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'red' } }).png().toBuffer()
    const blue = await sharp({ create: { width: 64, height: 48, channels: 3, background: 'blue' } }).png().toBuffer()
    const write = await engine.files.write(artifact.value.artifactId, 'original.png', red)
    if (!write.ok) throw new Error(write.error.message)
    const first = engine.head
    const next = await engine.files.write(artifact.value.artifactId, 'original.png', blue)
    if (!next.ok) throw new Error(next.error.message)
    return { book: created.value, artifact: artifact.value.artifactId, first, blue, red, head: engine.head,
      notebook: engine.notebooks.list()[0]!.id }
  } finally { await books.close() }
}

async function cli(library: string, args: string[]) {
  return exec(process.execPath, ['--import', 'tsx', 'server/src/cli/entry.ts', ...args, '--library', library, '--json'], {
    cwd: process.cwd(), timeout: testBudget(60_000), maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, VIDEOBOOK_OP_VAULT: '', VIDEOBOOK_OP_SERVICE_TOKEN: '', B2_BUCKET: '', B2_ACCESS_KEY_ID: '', B2_SECRET_ACCESS_KEY: '' },
  })
}

async function live(path: string) {
  const server = await startServer(path)
  servers.push(server)
  const client = new Client({ name: 'portable-book-test', version: '1' }, {
    capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
  })
  clients.push(client)
  await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  return { server, client }
}

describe('portable book CLI', () => {
  it('exports and imports with both apps open, preserves media/history and rejects repeat imports', async () => {
    const source = await root()
    const target = await root()
    const original = await seed(source)
    const from = await live(source)
    const into = await live(target)
    const keep = await callTool<{ bookId: string }>(into.client, 'create_book', { name: 'unrelated' })
    const sourcePid = JSON.parse(await readFile(join(source, 'books', '.videobook-server.json'), 'utf8')).pid as number
    const archivePath = join(source, 'pig.videobook.tar.gz')
    const exported = JSON.parse((await cli(join(source, 'books'), ['export-book', 'portable-pig', '--out', archivePath])).stdout) as BookArchiveResult
    expect(exported.manifest.book.bookId).toBe(original.book.bookId)
    expect(exported.manifest.head).toBe(original.head)
    const imported = JSON.parse((await cli(join(target, 'books'), ['import-book', archivePath])).stdout) as { book: { bookId: string }; automation_paused: boolean }
    expect(imported).toMatchObject({ book: { bookId: original.book.bookId }, automation_paused: true })
    const books = await callTool<Array<{ bookId: string }>>(into.client, 'list_books', {})
    expect(books.map((book) => book.bookId).sort()).toEqual([original.book.bookId, keep.bookId].sort())
    const response = await fetch(`${into.server.url.replace('/mcp', '')}/files/${original.book.bookId}/${original.artifact}/original.png`)
    expect(response.status).toBe(200)
    expect(Buffer.from(await response.arrayBuffer())).toEqual(original.blue)
    const notebook = await callTool<{ id: string }>(into.client, 'get_notebook', { book_id: original.book.bookId, notebook_id: original.notebook })
    expect(notebook.id).toBe(original.notebook)
    await expect(cli(join(target, 'books'), ['import-book', archivePath])).rejects.toThrow('already exists')
    expect((await callTool<Array<{ bookId: string }>>(from.client, 'list_books', {})).map((book) => book.bookId)).toContain(original.book.bookId)
    expect(JSON.parse(await readFile(join(source, 'books', '.videobook-server.json'), 'utf8')).pid).toBe(sourcePid)
    expect((await readdir(join(target, 'books'))).filter((name) => name.startsWith('.importing-'))).toEqual([])
    await into.client.close()
    await stopServer(into.server)
    const restored = new BookManager({ libraryDir: join(target, 'books') })
    try {
      await restored.ready()
      const selected = restored.get(original.book.bookId)
      if (!selected.ok) throw new Error(selected.error.message)
      expect(selected.value.engine.head).toBe(original.head)
      expect(selected.value.engine.settings.get(BOOK_AUTOMATION_PAUSED_KEY)).toBe(true)
      const old = await selected.value.engine.files.readAtRevision(original.artifact, 'original.png', original.first)
      expect(old.ok && old.value).toEqual(original.red)
    } finally { await restored.close() }
  })

  it('uses exclusive offline ownership without starting background work', async () => {
    const source = await root()
    const target = await root()
    const original = await seed(source)
    const archive = join(source, 'offline.tar.gz')
    await cli(join(source, 'books'), ['export-book', original.book.bookId, '--out', archive])
    await cli(join(target, 'books'), ['import-book', archive])
    expect((await readdir(join(target, 'books'))).filter((name) => name.startsWith('.'))).toEqual([])
    const books = new BookManager({ libraryDir: join(target, 'books') })
    try {
      await books.ready()
      expect(books.list().map((book) => book.bookId)).toEqual([original.book.bookId])
    } finally { await books.close() }
  })

  it('reserves names and identities across simultaneous imports and releases failed staging', async () => {
    const path = await root()
    const source = await root()
    const original = await seed(source)
    const books = new BookManager({ libraryDir: join(path, 'books') })
    try {
      const results = await Promise.allSettled([
        books.prepareImport(original.book, original.head),
        books.prepareImport({ ...original.book, name: 'different-name' }, original.head),
      ])
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
      const saved = results.find((result) => result.status === 'fulfilled')
      if (saved?.status !== 'fulfilled') throw new Error('No import reserved')
      await expect(books.commitImport(saved.value.token)).rejects.toThrow()
      expect(books.list()).toEqual([])
      expect((await readdir(join(path, 'books'))).filter((name) => name.startsWith('.importing-'))).toEqual([])
    } finally { await books.close() }
  })
})
