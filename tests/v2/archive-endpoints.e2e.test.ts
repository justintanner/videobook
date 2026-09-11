import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Sequence } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { archiveTags, indexKey, personMarkerKey, topicMarkerKey, type ArchiveIndex } from '../../server/src/archive-b2.js'
import { createLocalArchiveStore, type ArchiveStore } from '../../server/src/archive-store.js'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)
interface Restored { archive_id: string; asset_id: string; job_id: string }
interface RestoreResult { status: string; restored: Restored[]; skipped: Array<{ archive_id: string; asset_id: string }> }
interface Job { id: number; state: string; error?: unknown }
interface SearchResult { total: number; results: Array<{ archive_id: string; media: { url: string | null }; transcript_excerpt: string | null }> }

describe('archive endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let store: ArchiveStore
  let serial = 0

  const connect = async () => {
    server = await startServer(rootDir)
    client = new Client({ name: 'archive-http-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-archive-http-'))
    store = createLocalArchiveStore(join(rootDir, 'archive'))
    await connect()
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Archive restore fixtures' })).bookId
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, ...args })
  const restore = (ids: string[], args: Record<string, unknown> = {}) => call<RestoreResult>('restore_archive_clips', { archive_ids: ids, ...args })
  const assets = async () => (await call<{ assets: Array<{ artifact_id: string; type: string; duration: number | null }> }>('list_assets')).assets.filter((asset) => asset.type !== 'notebook')
  const jobs = () => call<Job[]>('list_jobs')
  const idle = async () => {
    let current: Job[] = []
    let previous = ''
    await expect.poll(async () => {
      current = await jobs()
      const signature = JSON.stringify(current.map((job) => [job.id, job.state]))
      const settled = signature === previous && current.every((job) => ['done', 'failed', 'aborted'].includes(job.state))
      previous = signature
      return settled
    }, { timeout: 60_000, interval: 150 }).toBe(true)
    expect(current.filter((job) => job.state !== 'done'), JSON.stringify(current)).toEqual([])
  }
  const bytes = async (url: string) => {
    const response = await fetch(`${server!.url.replace('/mcp', '')}${url}`)
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
  }
  const seed = async (extension: string, title = 'Archived cat', duration: number | null = 3, contentType?: string) => {
    const video = extension === 'mp4'
    const path = join(rootDir, `source-${++serial}.${extension}`)
    await execFileAsync(FFMPEG, [
      '-y', ...(video ? ['-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=24:d=3'] : []),
      '-f', 'lavfi', '-i', `sine=frequency=${440 + serial}:sample_rate=48000:duration=3`,
      ...(video ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] : []),
      ...(['weba', 'webm'].includes(extension) ? ['-f', 'webm', '-c:a', 'libopus'] : []), path,
    ])
    const data = await readFile(path)
    const hash = createHash('sha256').update(data).digest('hex')
    const prefix = `clips/${hash}`
    const index: ArchiveIndex = {
      schema_version: 1, archive_id: hash, sha256: hash, title,
      topics: archiveTags(['Cats'], 'manual'), people: archiveTags(['Cat keeper'], 'manual'), sources: [], ingests: [],
      media: { key: `${prefix}/source.${extension}`, filename: `source.${extension}`, content_type: contentType ?? (video ? 'video/mp4' : extension === 'weba' || extension === 'webm' ? 'audio/webm' : `audio/${extension}`), size_bytes: data.length },
      transcript: { json_key: `${prefix}/transcript.json`, text_key: `${prefix}/transcript.txt`, chunk_count: 1, provider: 'elevenlabs' },
      duration, created_at: '2026-09-01T00:00:00.000Z', updated_at: `2026-09-01T00:00:${String(serial).padStart(2, '0')}.000Z`,
    }
    await store.uploadFile(index.media.key, path, index.media.content_type)
    await store.putJson(indexKey(store, hash), index)
    await store.putText(index.transcript!.text_key, `${title}: the ginger cat plays with blue yarn.`)
    await store.putJson(index.transcript!.json_key, { text: 'Cat', words: [{ text: 'Cat', start: 0, end: 0.5, type: 'word' }] })
    const marker = { sha256: hash, ingest_id: 'fixture', index_key: indexKey(store, hash) }
    await store.putJson(topicMarkerKey(store, 'cats', hash, 'fixture'), marker)
    await store.putJson(personMarkerKey(store, 'cat-keeper', hash, 'fixture'), marker)
    return { hash, index, data }
  }

  it.each(['wav', 'flac', 'weba'])('restores %s audio with measured duration and current streams for timeline insertion', async (extension) => {
    const fixture = await seed(extension, 'Audio fixture', 99)
    const result = await restore([fixture.hash])
    expect(result.restored).toHaveLength(1)
    await idle()
    const id = result.restored[0]!.asset_id
    expect(await bytes(`/files/${bookId}/${id}/original.${extension}`)).toEqual(fixture.data)
    expect((await assets()).find((asset) => asset.artifact_id === id)?.duration).toBeCloseTo(3, 1)
    const streams = await call<Array<{ kind: string; objectHash: string }>>('list_media_streams', { artifact_id: id })
    expect(streams).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'audio', objectHash: fixture.hash })]))
    await call('add_timeline_audio', { asset_id: id, start_frame: 0 })
    expect((await call<Sequence>('get_primary_sequence')).clips[0]!.durationFrames).toBe(90)
  })

  it('restores audio-only WebM as audio instead of queueing video processing', async () => {
    const fixture = await seed('webm', 'Audio WebM', null, 'audio/webm')
    const result = await restore([fixture.hash])
    await idle()
    const id = result.restored[0]!.asset_id
    expect((await assets()).find((asset) => asset.artifact_id === id)).toMatchObject({ type: 'audio' })
    await call('add_timeline_audio', { asset_id: id, start_frame: 0 })
    expect((await call<Sequence>('get_primary_sequence')).clips[0]!.durationFrames).toBe(90)
  })

  it('restores video bytes, skips repeated IDs and retains readiness after restart', async () => {
    const fixture = await seed('mp4')
    const result = await restore([` ${fixture.hash.toUpperCase()} `, fixture.hash])
    expect(result.restored).toHaveLength(1)
    await idle()
    const id = result.restored[0]!.asset_id
    expect(await bytes(`/files/${bookId}/${id}/original.mp4`)).toEqual(fixture.data)
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: id }] })
    expect((await call<Sequence>('get_primary_sequence')).clips[0]!.durationFrames).toBe(90)
    await client.close()
    await stopServer(server)
    await connect()
    expect(await restore([fixture.hash])).toMatchObject({ status: 'noop', restored: [], skipped: [{ archive_id: fixture.hash, asset_id: id }] })
    expect(await bytes(`/files/${bookId}/${id}/original.mp4`)).toEqual(fixture.data)
  })

  it('creates only one asset across concurrent skip-existing requests', async () => {
    const fixture = await seed('wav')
    const results = await Promise.all(Array.from({ length: 6 }, () => restore([fixture.hash])))
    expect(results.flatMap((result) => result.restored)).toHaveLength(1)
    expect(results.flatMap((result) => result.skipped)).toHaveLength(5)
    await idle()
    expect(await assets()).toHaveLength(1)
  })

  it('deduplicates every clip across overlapping concurrent restore batches', async () => {
    const first = await seed('wav')
    const second = await seed('flac')
    const results = await Promise.all(Array.from({ length: 6 }, (_, index) => restore(index % 2 ? [second.hash, first.hash] : [first.hash, second.hash])))
    expect(results.flatMap((result) => result.restored)).toHaveLength(2)
    expect(results.flatMap((result) => result.skipped)).toHaveLength(10)
    await idle()
    expect(await assets()).toHaveLength(2)
  })

  it('preflights unsupported media in an entire batch before creating any assets or jobs', async () => {
    const fixture = await seed('wav')
    const invalidHash = 'a'.repeat(64)
    await store.putJson(indexKey(store, invalidHash), { ...fixture.index, archive_id: invalidHash, sha256: invalidHash, media: { ...fixture.index.media, filename: 'notes.txt', content_type: 'text/plain' } })
    const before = await assets()
    const beforeJobs = await jobs()
    const result = await client.callTool({ name: 'restore_archive_clips', arguments: { book_id: bookId, archive_ids: [fixture.hash, invalidHash] } })
    expect(result.isError).toBe(true)
    expect(await assets()).toEqual(before)
    expect(await jobs()).toEqual(beforeJobs)
  })

  it('preflights missing or malformed archive IDs without changing the target book', async () => {
    const fixture = await seed('wav')
    const before = await assets()
    for (const ids of [[fixture.hash, 'b'.repeat(64)], ['invalid'], ['  ']]) {
      const result = await client.callTool({ name: 'restore_archive_clips', arguments: { book_id: bookId, archive_ids: ids } })
      expect(result.isError).toBe(true)
    }
    expect(await assets()).toEqual(before)
    expect(await jobs()).toEqual([])
  })

  it('permits explicit duplicates while keeping skip-existing scoped to the target book', async () => {
    const fixture = await seed('wav')
    const first = await restore([fixture.hash])
    const duplicate = await restore([fixture.hash], { skip_existing: false })
    const other = await callTool<{ bookId: string }>(client, 'create_book', { name: 'Other archive book' })
    const foreign = await restore([fixture.hash], { book_id: other.bookId })
    const ids = [first, duplicate, foreign].flatMap((result) => result.restored.map((item) => item.asset_id))
    expect(new Set(ids).size).toBe(3)
    await idle()
    expect(await assets()).toHaveLength(2)
  })

  it('searches titles, topics, people and transcripts with stable pagination and playable archive URLs', async () => {
    const first = await seed('mp4', 'First cat')
    const second = await seed('wav', 'Second cat')
    const third = await seed('flac', 'Third cat')
    const page = await call<SearchResult>('search_archive', { query: 'BLUE YARN', sort: 'oldest', offset: 1, limit: 1 })
    expect(page.total).toBe(3)
    expect(page.results.map((item) => item.archive_id)).toEqual([second.hash])
    expect(await bytes(page.results[0]!.media.url!)).toEqual(second.data)
    for (const args of [{ topics: [' CATS '] }, { people: ['Cat keeper'] }]) {
      const result = await call<SearchResult>('search_archive', { ...args, sort: 'newest', presign_media: false })
      expect(result.results.map((item) => item.archive_id)).toEqual([third.hash, second.hash, first.hash])
      expect(result.results.every((item) => item.media.url === null)).toBe(true)
    }
    expect((await call<SearchResult>('search_archive', { query: 'does not exist' })).total).toBe(0)
  })
})
