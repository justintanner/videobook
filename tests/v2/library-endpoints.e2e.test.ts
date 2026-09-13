import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { v7 as uuidv7 } from 'uuid'
import { type Sequence } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { seedMixedStatusCatalog } from './library-browse-fixture.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)

interface Notebook { id: string; revision: string; cells: Array<{ id: string; output_artifact_id?: string }> }
interface Asset { artifact_id: string; type: string; tags: { effective: Array<{ key: string }> } }

describe('library endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let sourceBook: string
  let targetBook: string
  let graph: Notebook

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-library-endpoints-'))
    server = await startServer(rootDir)
    client = new Client({ name: 'library-endpoints-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    sourceBook = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Source library' })).bookId
    targetBook = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Destination library' })).bookId
    graph = await call<Notebook>(targetBook, 'create_notebook', { name: 'Media targets' })
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(book: string, name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: book, ...args })
  const notebook = () => call<Notebook>(targetBook, 'get_notebook', { notebook_id: graph.id })
  const assets = async (book = targetBook) => (await call<{ assets: Asset[] }>(book, 'list_assets')).assets
  const idle = async (book: string) => {
    await expect.poll(async () => (await call<Array<{ state: string }>>(book, 'list_jobs')).every((job) => job.state === 'done'), { timeout: 60_000 }).toBe(true)
  }
  const upload = async (kind: 'video' | 'audio', book = sourceBook) => {
    const filename = `original.${kind === 'video' ? 'mp4' : 'wav'}`
    const path = join(rootDir, `${uuidv7()}-${filename}`)
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i',
      kind === 'video' ? 'testsrc2=s=160x90:r=30:d=4' : 'sine=frequency=440:duration=4',
      ...(kind === 'video' ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : ['-c:a', 'pcm_s16le']), path])
    const uploaded = await call<{ assetId: string; processingError?: string }>(book, 'upload_file', { filename, data: (await readFile(path)).toString('base64') })
    expect(uploaded.processingError).toBeUndefined()
    await idle(book)
    return uploaded.assetId
  }
  const cell = async (kind: 'video' | 'audio') => (await call<{ id: string }>(targetBook, 'create_notebook_cell', {
    notebook_id: graph.id, cell: { type: kind, slot: { row: 0, column: 0 } },
  })).id
  const bytes = async (book: string, id: string, filename: string) => {
    const response = await fetch(`${server!.url.replace('/mcp', '')}/files/${book}/${id}/${filename}`)
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
  }
  const attachment = (assetId: string, cellId: string, expected: string | null = null) => ({
    source_book_id: sourceBook, source_artifact_id: assetId, target_book_id: targetBook,
    notebook_id: graph.id, cell_id: cellId, expected_output_artifact_id: expected,
  })

  it.each(['video', 'audio'] as const)('copies a trimmed %s using its current media streams', async (kind) => {
    const source = await upload(kind)
    await call(sourceBook, 'add_asset_tag', { asset_id: source, facet: 'custom', label: 'Edited clip' })
    await call(sourceBook, kind === 'video' ? 'trim_video' : 'trim_audio', { asset_id: source, trim_start: 1, trim_end: 3 })
    await idle(sourceBook)
    const cellId = await cell(kind)
    const copied = await call<{ target_artifact_id: string }>(targetBook, 'attach_library_asset', attachment(source, cellId))
    await idle(targetBook)
    const filename = kind === 'video' ? 'original.mp4' : 'original.wav'
    const original = await bytes(sourceBook, source, filename)
    expect(await bytes(targetBook, copied.target_artifact_id, filename)).toEqual(original)
    expect((await notebook()).cells[0]!.output_artifact_id).toBe(copied.target_artifact_id)
    expect((await assets()).find((asset) => asset.artifact_id === copied.target_artifact_id)?.tags.effective).toEqual(expect.arrayContaining([expect.objectContaining({ key: 'edited clip' })]))
    const path = join(rootDir, filename)
    await writeFile(path, original)
    const probe = await probeVideo(path)
    expect(probe.duration).toBeCloseTo(2, 1)
    if (kind === 'video') await call(targetBook, 'set_timeline', { render: 'landscape', slots: [{ artifact_id: copied.target_artifact_id }] })
    else await call(targetBook, 'add_timeline_audio', { asset_id: copied.target_artifact_id, start_frame: 0 })
    const duration = kind === 'video' ? probe.videoDuration : probe.audioDuration
    if (duration === null) throw new Error('Copied media has no timed stream')
    expect((await call<Sequence>(targetBook, 'get_primary_sequence')).clips[0]!.durationFrames).toBe(Math.round(duration * 30))
  })

  it('attaches and clears local media with revision checks while preserving source bytes', async () => {
    const source = await upload('audio', targetBook)
    const cellId = await cell('audio')
    const original = await bytes(targetBook, source, 'original.wav')
    const before = await notebook()
    const attached = await call<{ revision: string }>(targetBook, 'set_notebook_media_slot', { notebook_id: graph.id, cell_id: cellId, artifact_ref: source, expected_revision: before.revision })
    expect((await notebook()).cells[0]!.output_artifact_id).toBe(source)
    const rejected = await client.callTool({ name: 'set_notebook_media_slot', arguments: {
      book_id: targetBook, notebook_id: graph.id, cell_id: cellId, artifact_ref: null, expected_revision: before.revision,
    } })
    expect(rejected.isError).toBe(true)
    expect((await notebook()).cells[0]!.output_artifact_id).toBe(source)
    await call(targetBook, 'set_notebook_media_slot', { notebook_id: graph.id, cell_id: cellId, artifact_ref: null, expected_revision: attached.revision })
    expect((await notebook()).cells[0]!.output_artifact_id).toBeUndefined()
    expect(await bytes(targetBook, source, 'original.wav')).toEqual(original)
  })

  it('rejects incompatible foreign media before creating a target artifact', async () => {
    const source = await upload('video')
    const cellId = await cell('audio')
    const before = await notebook()
    const beforeAssets = await assets()
    const rejected = await client.callTool({ name: 'attach_library_asset', arguments: attachment(source, cellId) })
    expect(rejected.isError).toBe(true)
    expect(await assets()).toEqual(beforeAssets)
    expect(await notebook()).toEqual(before)
  })

  it('rejects a stale attachment target without replacing its current media', async () => {
    const foreign = await upload('audio')
    const local = await upload('audio', targetBook)
    const cellId = await cell('audio')
    await call(targetBook, 'set_notebook_media_slot', { notebook_id: graph.id, cell_id: cellId, artifact_ref: local })
    const before = await notebook()
    const beforeAssets = await assets()
    const rejected = await client.callTool({ name: 'attach_library_asset', arguments: attachment(foreign, cellId) })
    expect(rejected.isError).toBe(true)
    expect(await notebook()).toEqual(before)
    expect(await assets()).toEqual(beforeAssets)
  })

  it('finds tagged media across books with the owning identities intact', async () => {
    const source = await upload('audio')
    await call(sourceBook, 'add_asset_tag', { asset_id: source, facet: 'custom', label: 'Cross book' })
    const result = await call<{ assets: Array<{ artifact_id: string; owning_book_id: string }> }>(targetBook, 'search_library_assets', {
      kinds: ['audio'], tags_all: [{ facet: 'custom', label: 'cross book' }],
    })
    expect(result.assets).toHaveLength(1)
    expect(result.assets[0]).toMatchObject({ artifact_id: source, owning_book_id: sourceBook })
  })

  it('cleans up the losing copy when two attachments compete for the same cell', async () => {
    const source = await upload('video')
    const cellId = await cell('video')
    const results = await Promise.allSettled([0, 1].map(() =>
      call<{ target_artifact_id: string }>(targetBook, 'attach_library_asset', attachment(source, cellId))))
    const completed = results.filter((result) => result.status === 'fulfilled')
    expect(completed).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    const winner = completed[0]!.value.target_artifact_id
    expect((await notebook()).cells[0]!.output_artifact_id).toBe(winner)
    expect((await assets()).filter((asset) => asset.type === 'video').map((asset) => asset.artifact_id)).toEqual([winner])
    expect(await bytes(targetBook, winner, 'original.mp4')).toEqual(await bytes(sourceBook, source, 'original.mp4'))
  })
})

describe('library browse status over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let thisBook: string
  let otherBook: string
  let thisCatalog: Awaited<ReturnType<typeof seedMixedStatusCatalog>>
  let otherCatalog: Awaited<ReturnType<typeof seedMixedStatusCatalog>>

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-library-browse-'))
    const books = new BookManager({
      libraryDir: join(rootDir, 'books'),
      objectPrefix: 'test-objects',
    })
    await books.ready()
    const createdThis = await books.create('this-book')
    const createdOther = await books.create('other-book')
    if (!createdThis.ok || !createdOther.ok) {
      throw new Error('Could not seed browse books')
    }
    const thisManaged = books.get(createdThis.value.bookId)
    const otherManaged = books.get(createdOther.value.bookId)
    if (!thisManaged.ok || !otherManaged.ok) {
      throw new Error('Could not open seeded browse books')
    }
    thisBook = createdThis.value.bookId
    otherBook = createdOther.value.bookId
    thisCatalog = await seedMixedStatusCatalog(thisManaged.value.engine, {
      ready: 16,
      error: 110,
      processing: 110,
    })
    otherCatalog = await seedMixedStatusCatalog(otherManaged.value.engine, {
      ready: 10,
      error: 70,
      processing: 60,
    })
    await books.close()
    server = await startServer(rootDir)
    client = new Client({ name: 'library-browse-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(book: string, name: string, args: Record<string, unknown> = {}) =>
    callTool<T>(client, name, { book_id: book, ...args })

  it('pages Ready media across books and scopes Errors to the selected book', async () => {
    type Listed = {
      assets: Array<{ artifact_id: string; status: string; type: string; owning_book_id?: string }>
      page: { offset: number; limit: number; total: number; hasMore: boolean }
      status_counts: { ready: number; processing: number; error: number }
    }

    const unfiltered = await call<Listed>(thisBook, 'list_assets', {
      sort: 'newest',
      limit: 200,
    })
    expect(unfiltered.page.hasMore).toBe(true)
    expect(unfiltered.assets.filter((asset) => thisCatalog.ready.includes(asset.artifact_id)))
      .toEqual([])
    expect(unfiltered.status_counts).toEqual({
      ready: thisCatalog.ready.length,
      processing: thisCatalog.processing.length,
      error: thisCatalog.error.length,
    })

    const readyPage = await call<Listed>(thisBook, 'list_assets', {
      sort: 'newest',
      limit: 10,
      browse_status: 'ready',
    })
    expect(readyPage.assets.length).toBeGreaterThan(0)
    expect(readyPage.assets.every((asset) => asset.status === 'ready')).toBe(true)
    expect(readyPage.assets.every((asset) => asset.type !== 'notebook')).toBe(true)
    expect(readyPage.page.total).toBe(thisCatalog.ready.length)
    expect(readyPage.page.hasMore).toBe(true)

    const readyIds: string[] = []
    let offset = 0
    let hasMore = true
    while (hasMore) {
      const page = await call<Listed>(thisBook, 'list_assets', {
        sort: 'newest',
        limit: 10,
        offset,
        browse_status: 'ready',
      })
      readyIds.push(...page.assets.map((asset) => asset.artifact_id))
      hasMore = page.page.hasMore
      offset += page.assets.length
      if (page.assets.length === 0) break
    }
    expect(new Set(readyIds).size).toBe(readyIds.length)
    expect([...readyIds].sort()).toEqual([...thisCatalog.ready].sort())

    const thisErrors = await call<Listed>(thisBook, 'list_assets', {
      browse_status: 'error',
      limit: 500,
    })
    expect(thisErrors.page.total).toBe(thisCatalog.error.length)
    expect(thisErrors.assets.map((asset) => asset.artifact_id).sort())
      .toEqual([...thisCatalog.error].sort())

    const libraryErrors = await call<Listed>(thisBook, 'search_library_assets', {
      kinds: ['image'],
      browse_status: 'error',
      limit: 100,
    })
    expect(libraryErrors.page.total).toBe(thisCatalog.error.length + otherCatalog.error.length)
    expect(libraryErrors.assets.some((asset) => asset.owning_book_id === thisBook)).toBe(true)
    expect(libraryErrors.assets.some((asset) => asset.owning_book_id === otherBook)).toBe(true)
    expect(libraryErrors.status_counts).toEqual({
      ready: thisCatalog.ready.length + otherCatalog.ready.length,
      processing: thisCatalog.processing.length + otherCatalog.processing.length,
      error: thisCatalog.error.length + otherCatalog.error.length,
    })

    const libraryReady = await call<Listed>(thisBook, 'search_library_assets', {
      kinds: ['image'],
      browse_status: 'ready',
      limit: 10,
    })
    expect(libraryReady.assets.every((asset) => asset.status === 'ready')).toBe(true)
    expect(libraryReady.page.total).toBe(thisCatalog.ready.length + otherCatalog.ready.length)
    expect(libraryReady.page.hasMore).toBe(true)

    const defaultSearch = await call<Listed>(thisBook, 'search_library_assets', {
      kinds: ['image'],
      limit: 50,
    })
    expect(defaultSearch.assets.every((asset) => asset.status === 'ready')).toBe(true)
    expect(defaultSearch.page.total).toBe(thisCatalog.ready.length + otherCatalog.ready.length)
  })
})
