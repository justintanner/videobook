import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Job, Sequence } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)

describe('job recovery endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let video: Buffer

  const connect = async () => {
    server = await startServer(rootDir)
    client = new Client({ name: 'job-recovery-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  }
  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, ...args })
  const jobs = () => call<Job[]>('list_jobs')
  const reject = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: { book_id: bookId, ...args } })
    expect(result.isError, JSON.stringify(result)).toBe(true)
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-job-recovery-'))
    const path = join(rootDir, 'fixture.mp4')
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x90:r=30:d=3', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path])
    video = await readFile(path)
    await connect()
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Job recovery fixture' })).bookId
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  it.each(['failed', 'aborted'] as const)('retries a %s media job after restart and preserves its original terminal record', async (state) => {
    const uploaded = await call<{ assetId: string; processingError?: string }>('upload_file', {
      filename: 'repairable.mp4', data: (state === 'failed' ? Buffer.from('broken mp4 bytes') : video).toString('base64'),
    })
    if (state === 'failed') expect(uploaded.processingError).toBeTruthy()
    else expect(uploaded.processingError).toBeUndefined()
    let original = (await jobs()).find((job) => job.type === 'process_video' && job.payload.assetId === uploaded.assetId)!
    expect(original.state).toBe(state === 'failed' ? 'failed' : 'done')
    await client.close()
    await stopServer(server)
    const books = new BookManager({ libraryDir: join(rootDir, 'books'), objectPrefix: 'test-objects' })
    await books.ready()
    try {
      const managed = books.get(bookId)
      if (!managed.ok) throw new Error(managed.error.message)
      const engine = managed.value.engine
      if (state === 'failed') {
        const repaired = await engine.files.write(uploaded.assetId, 'original.mp4', video)
        if (!repaired.ok) throw new Error(repaired.error.message)
      } else {
        const queued = engine.jobs.queue.enqueue({ type: original.type, artifactId: uploaded.assetId, payload: original.payload, dedupeKey: 'cancel-recovery-fixture' })
        const claimed = engine.jobs.queue.dequeue(process.pid, 120_000, [], ['process_video'])
        expect(claimed?.id).toBe(queued.job.id)
        original = claimed!
      }
    } finally {
      await books.close()
    }
    await connect()
    if (state === 'aborted') {
      const cancelled = await call<Job>('cancel_job', { job_id: original.id, reason: 'Cancel recovery fixture' })
      expect(cancelled).toMatchObject({ state: 'aborted', error: { message: 'Cancel recovery fixture' } })
    }
    const terminal = (await jobs()).find((job) => job.id === original.id)!
    expect(terminal.state).toBe(state)
    const retry = await call<{ retry_job_id: string; source_job_id: number }>('retry_job', { job_id: original.id })
    expect(retry.source_job_id).toBe(original.id)
    expect(retry.retry_job_id).toMatch(/^retry-process_video-/)
    await expect.poll(async () => (await jobs()).find((job) => job.type === original.type && job.id > original.id)?.state, { timeout: 30_000 }).toBe('done')
    expect((await jobs()).find((job) => job.id === original.id)).toEqual(terminal)
    const completed = (await jobs()).find((job) => job.type === original.type && job.id > original.id)!
    expect(completed.result).toMatchObject({ success: true, duration: 3 })
    expect(completed.payload.bookId).toBe(bookId)
    await reject('retry_job', { job_id: completed.id })
    await reject('cancel_job', { job_id: completed.id })
    const foreign = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Other jobs' })).bookId
    await reject('cancel_job', { book_id: foreign, job_id: original.id })
    await reject('retry_job', { book_id: foreign, job_id: original.id })
    expect(await call('list_jobs', { book_id: foreign, job_ids: [original.id] })).toEqual([])
    await call('set_timeline', { slots: [{ artifact_id: uploaded.assetId }], render: 'landscape' })
    expect((await call<Sequence>('get_primary_sequence')).clips).toEqual([
      expect.objectContaining({ durationFrames: 90, source: expect.objectContaining({ artifactId: uploaded.assetId }) }),
    ])
    await client.close()
    await stopServer(server)
    await connect()
    expect((await jobs()).find((job) => job.id === original.id)).toEqual(terminal)
  })

  it('keeps a repeated media failure diagnostic and validates job identifiers', async () => {
    const uploaded = await call<{ assetId: string; processingError?: string }>('upload_file', { filename: 'still-broken.mp4', data: Buffer.from('broken media').toString('base64') })
    expect(uploaded.processingError).toBeTruthy()
    const original = (await jobs()).find((job) => job.type === 'process_video')!
    await call('retry_job', { job_id: original.id })
    await expect.poll(async () => (await jobs()).find((job) => job.id > original.id)?.state, { timeout: 30_000 }).toBe('failed')
    const repeated = (await jobs()).find((job) => job.id > original.id)!
    expect(repeated.error?.message).toMatch(/ffprobe|Invalid data|moov atom/i)
    expect((await jobs()).find((job) => job.id === original.id)).toEqual(original)
    for (const job_id of [-1, 0, 0.5, 999_999]) {
      await reject('retry_job', { job_id })
      await reject('cancel_job', { job_id })
    }
    await reject('list_jobs', { job_ids: [] })
    await reject('list_jobs', { limit: 501 })
  })
})
