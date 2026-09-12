import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

interface Book { bookId: string; name: string }
interface Notebook { id: string; name: string; revision: string; cells: Array<{ id: string; output_artifact_id?: string }> }

describe('book lifecycle endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client

  const connect = async () => {
    server = await startServer(rootDir)
    client = new Client({ name: 'book-lifecycle-http-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  }
  const restart = async () => {
    await client.close()
    await stopServer(server)
    await connect()
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-books-http-'))
    await connect()
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, args)
  const create = (name: string) => call<Book>('create_book', { name })
  const books = () => call<Book[]>('list_books')
  const notebook = (book: string, id: string) => call<Notebook>('get_notebook', { book_id: book, notebook_id: id })
  const picture = async (book: string) => {
    const data = await sharp({ create: { width: 96, height: 64, channels: 3, background: 'red' } }).png().toBuffer()
    const uploaded = await call<{ assetId: string; processingError?: string }>('upload_file', { book_id: book, filename: 'picture.png', data: data.toString('base64') })
    expect(uploaded.processingError).toBeUndefined()
    await expect.poll(async () => (await call<Array<{ state: string }>>('list_jobs', { book_id: book })).every((job) => job.state === 'done'), { timeout: 30_000 }).toBe(true)
    return { id: uploaded.assetId, data }
  }
  const bytes = async (book: string, id: string) => {
    const response = await fetch(`${server!.url.replace('/mcp', '')}/files/${book}/${id}/original.png`)
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
  }

  it('renames a book while preserving notebook and media identities across restart', async () => {
    const book = await create('  Original book  ')
    expect(book.name).toBe('original-book')
    const graph = await call<Notebook>('create_notebook', { book_id: book.bookId, name: 'Working board' })
    const image = await picture(book.bookId)
    await call('rename_book', { book_id: book.bookId, name: '  Renamed 猫  ' })
    expect(await call('get_book', { book_id: book.bookId })).toMatchObject({ bookId: book.bookId, name: 'renamed' })
    await restart()
    expect(await call('get_book', { book_id: book.bookId })).toMatchObject({ bookId: book.bookId, name: 'renamed' })
    expect(await notebook(book.bookId, graph.id)).toMatchObject({ id: graph.id, name: 'Working board' })
    expect(await bytes(book.bookId, image.id)).toEqual(image.data)
  })

  it('rejects blank and duplicate names without changing either book', async () => {
    const first = await create('First')
    const second = await create('Second')
    for (const name of [' first ', 'FIRST', '   ', '___', '猫🐈']) {
      const result = await client.callTool({ name: 'rename_book', arguments: { book_id: second.bookId, name } })
      expect(result.isError).toBe(true)
    }
    expect(await call('get_book', { book_id: first.bookId })).toMatchObject({ name: 'first' })
    expect(await call('get_book', { book_id: second.bookId })).toMatchObject({ name: 'second' })
    const duplicate = await client.callTool({ name: 'create_book', arguments: { name: ' FIRST ' } })
    expect(duplicate.isError).toBe(true)
    expect(await books()).toHaveLength(2)
  })

  it('allows only one concurrent rename to claim a new book name', async () => {
    const first = await create('First')
    const second = await create('Second')
    const results = await Promise.allSettled([first, second].map((book) => call<Book>('rename_book', { book_id: book.bookId, name: 'Shared name' })))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await restart()
    const listed = await books()
    expect(listed).toHaveLength(2)
    expect(listed.filter((book) => book.name === 'shared-name')).toHaveLength(1)
  })

  it('does not leave abandoned book roots after concurrent duplicate creates', async () => {
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => create('Shared creation')))
    const winners = results.filter((result) => result.status === 'fulfilled')
    expect(winners).toHaveLength(1)
    expect(await books()).toHaveLength(1)
    await client.close()
    await stopServer(server)
    const manager = new BookManager({ libraryDir: join(rootDir, 'books') })
    try { expect(await manager.discover()).toEqual([winners[0]!.value.bookId]) }
    finally { await manager.close() }
    await connect()
    expect(await books()).toEqual(expect.arrayContaining([expect.objectContaining({ bookId: winners[0]!.value.bookId })]))
  })

  it('deletes only the confirmed book and permits its name to be reused', async () => {
    const first = await create('Delete fixture')
    const second = await create('Keep fixture')
    const image = await picture(second.bookId)
    const rejected = await client.callTool({ name: 'delete_book', arguments: { book_id: first.bookId, confirm_name: 'wrong' } })
    expect(rejected.isError).toBe(true)
    expect(await books()).toHaveLength(2)
    await call('delete_book', { book_id: first.bookId, confirm_name: first.name })
    expect(await books()).toEqual(expect.arrayContaining([expect.objectContaining({ bookId: second.bookId })]))
    expect((await client.callTool({ name: 'get_book', arguments: { book_id: first.bookId } })).isError).toBe(true)
    expect(await bytes(second.bookId, image.id)).toEqual(image.data)
    const replacement = await create('Delete fixture')
    expect(replacement.bookId).not.toBe(first.bookId)
    await restart()
    expect((await books()).map((book) => book.bookId).sort()).toEqual([second.bookId, replacement.bookId].sort())
  })

  it('renames and deletes notebooks while protecting foreign notebooks and retained media', async () => {
    const first = await create('First')
    const second = await create('Second')
    const graph = await call<Notebook>('create_notebook', { book_id: first.bookId, name: 'Board' })
    const image = await picture(first.bookId)
    await call('create_notebook_cell', { book_id: first.bookId, notebook_id: graph.id, cell: { type: 'image', slot: { row: 0, column: 0 }, output_artifact_id: image.id } })
    for (const name of ['rename_notebook', 'delete_notebook']) {
      const result = await client.callTool({ name, arguments: { book_id: second.bookId, notebook_id: graph.id, name: 'Wrong book' } })
      expect(result.isError).toBe(true)
    }
    await call('rename_notebook', { book_id: first.bookId, notebook_id: graph.id, name: 'Renamed board' })
    expect(await notebook(first.bookId, graph.id)).toMatchObject({ name: 'Renamed board' })
    await call('delete_notebook', { book_id: first.bookId, notebook_id: graph.id })
    expect((await client.callTool({ name: 'get_notebook', arguments: { book_id: first.bookId, notebook_id: graph.id } })).isError).toBe(true)
    expect(await bytes(first.bookId, image.id)).toEqual(image.data)
    await restart()
    expect(await call<Notebook[]>('list_notebooks', { book_id: first.bookId })).toHaveLength(1)
  })
})
