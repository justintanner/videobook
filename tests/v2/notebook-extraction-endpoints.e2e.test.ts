import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import sharp from 'sharp'
import type { Sequence } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)

interface Cell { id: string; type: string; slot: { row: number; column: number }; output_artifact_id?: string; inputs?: Record<string, unknown> }
interface Notebook { id: string; revision: string; cells: Cell[]; edges: Array<{ source: string; target: string }> }
interface Extraction { cell_id: string; job_id: string }
interface Job { id: number; state: string; error?: unknown }

describe('notebook extraction endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let notebookId: string
  let serial = 0

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-notebook-extraction-http-'))
    server = await startServer(rootDir)
    client = new Client({ name: 'notebook-extraction-http-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Notebook extraction fixtures' })).bookId
    notebookId = (await call<Notebook>('create_notebook', { name: 'Extract media' })).id
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, ...args })
  const notebook = () => call<Notebook>('get_notebook', { notebook_id: notebookId })
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
    }, { timeout: 60_000, interval: 200 }).toBe(true)
    expect(current.filter((job) => job.state !== 'done'), JSON.stringify(current)).toEqual([])
  }
  const bytes = async (id: string, filename: string) => {
    const response = await fetch(`${server!.url.replace('/mcp', '')}/files/${bookId}/${id}/${filename}`)
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
  }
  const duration = async (id: string) => {
    const path = join(rootDir, `output-${++serial}.m4a`)
    await writeFile(path, await bytes(id, 'original.m4a'))
    const probe = await probeVideo(path)
    expect(probe.hasAudio).toBe(true)
    return probe.audioDuration ?? probe.duration
  }
  const source = async (hasAudio = true) => {
    const path = join(rootDir, `source-${++serial}.mp4`)
    await execFileAsync(FFMPEG, [
      '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x96:r=24:d=1.5',
      '-f', 'lavfi', '-i', 'color=c=blue:s=160x96:r=24:d=1.5',
      ...(hasAudio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'] : []),
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
      ...(hasAudio ? ['-map', '2:a', '-c:a', 'aac'] : []), '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path,
    ])
    const uploaded = await call<{ assetId: string; processingError?: string }>('upload_file', { filename: 'source.mp4', data: (await readFile(path)).toString('base64') })
    expect(uploaded.processingError).toBeUndefined()
    await idle()
    const cell = await call<Cell>('create_notebook_cell', { notebook_id: notebookId, cell: { type: 'video', slot: { row: 0, column: 0 } } })
    await call('set_notebook_media_slot', { notebook_id: notebookId, cell_id: cell.id, artifact_ref: uploaded.assetId })
    return { cellId: cell.id, assetId: uploaded.assetId }
  }
  const output = async (cellId: string) => {
    await idle()
    const cell = (await notebook()).cells.find((candidate) => candidate.id === cellId)!
    expect(cell.inputs?.state).toBe('completed')
    expect(cell.output_artifact_id).toBeTruthy()
    return cell
  }

  it.each([
    { start_seconds: 1, duration_seconds: 0.8, expected: 0.8 },
    { duration_seconds: 0.5, expected: 0.5 },
    { start_seconds: 2, expected: 1 },
  ])('retains selected audio range $expected seconds when rerun', async ({ expected, ...range }) => {
    const input = await source()
    const sourceBytes = await bytes(input.assetId, 'original.mp4')
    const extracted = await call<Extraction>('extract_notebook_audio', { notebook_id: notebookId, source_cell_id: input.cellId, ...range })
    const first = await output(extracted.cell_id)
    expect(await duration(first.output_artifact_id!)).toBeCloseTo(expected, 1)
    expect((await notebook()).edges).toEqual(expect.arrayContaining([expect.objectContaining({ source: input.cellId, target: first.id })]))
    await call('run_notebook_cell', { notebook_id: notebookId, cell_id: first.id })
    const rerun = await output(first.id)
    expect(rerun.output_artifact_id).not.toBe(first.output_artifact_id)
    expect(await duration(rerun.output_artifact_id!)).toBeCloseTo(expected, 1)
    expect(await duration(first.output_artifact_id!)).toBeCloseTo(expected, 1)
    expect(await bytes(input.assetId, 'original.mp4')).toEqual(sourceBytes)
    await call('add_timeline_audio', { asset_id: rerun.output_artifact_id, start_frame: 0 })
    expect((await call<Sequence>('get_primary_sequence')).clips[0]!.durationFrames).toBe(Math.round(expected * 30))
  })

  it.each([
    { frame_mode: 'first', channel: 0 },
    { frame_mode: 'time', timestamp_seconds: 2, channel: 2 },
    { frame_mode: 'last', channel: 2 },
    { frame_mode: 'time', timestamp_seconds: 99, channel: 2 },
  ])('captures $frame_mode at $timestamp_seconds and repeats the same frame', async ({ channel, ...frame }) => {
    const input = await source()
    const extracted = await call<Extraction>('extract_notebook_frame', { notebook_id: notebookId, source_cell_id: input.cellId, ...frame })
    const first = await output(extracted.cell_id)
    const image = await bytes(first.output_artifact_id!, 'original.jpg')
    expect((await sharp(image).stats()).channels[channel]!.mean).toBeGreaterThan(240)
    expect(Number(first.inputs?.atSeconds)).toBeLessThan(3)
    const repeated = await call<Extraction>('extract_notebook_frame', { notebook_id: notebookId, source_cell_id: input.cellId, ...frame })
    const rerun = await output(repeated.cell_id)
    expect(rerun.slot).not.toEqual(first.slot)
    expect(await bytes(rerun.output_artifact_id!, 'original.jpg')).toEqual(image)
    expect(rerun.inputs?.atSeconds).toBe(first.inputs?.atSeconds)
  })

  it.each([true, false])('rejects invalid audio extraction before creating notebook cells, with audio=%s', async (hasAudio) => {
    const input = await source(hasAudio)
    const before = await notebook()
    const beforeJobs = await jobs()
    const result = await client.callTool({ name: 'extract_notebook_audio', arguments: {
      book_id: bookId, notebook_id: notebookId, source_cell_id: input.cellId, ...(hasAudio ? { start_seconds: 10 } : {}),
    } })
    expect(result.isError).toBe(true)
    expect(await notebook()).toEqual(before)
    expect(await jobs()).toEqual(beforeJobs)
  })

  it('rejects stale revisions and missing timestamps without adding cells', async () => {
    const input = await source()
    const before = await notebook()
    for (const request of [
      { name: 'extract_notebook_frame', arguments: { frame_mode: 'time' } },
      { name: 'extract_notebook_frame', arguments: { frame_mode: 'first', expected_revision: 'stale' } },
      { name: 'extract_notebook_audio', arguments: { expected_revision: 'stale' } },
    ]) {
      const result = await client.callTool({ name: request.name, arguments: { book_id: bookId, notebook_id: notebookId, source_cell_id: input.cellId, ...request.arguments } })
      expect(result.isError).toBe(true)
      expect(await notebook()).toEqual(before)
    }
  })

  it('accepts only one extraction when concurrent requests share an expected revision', async () => {
    const input = await source()
    const before = await notebook()
    const results = await Promise.allSettled([0, 1].map(() => call<Extraction>('extract_notebook_audio', {
      notebook_id: notebookId, source_cell_id: input.cellId, duration_seconds: 0.5, expected_revision: before.revision,
    })))
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1)
    await idle()
    expect((await notebook()).cells).toHaveLength(2)
  })

  it.each([undefined, 3])('keeps the requested audio range when the source grows, duration=%s', async (durationSeconds) => {
    const input = await source()
    const extracted = await call<Extraction>('extract_notebook_audio', {
      notebook_id: notebookId, source_cell_id: input.cellId, start_seconds: 2,
      ...(durationSeconds === undefined ? {} : { duration_seconds: durationSeconds }),
    })
    const first = await output(extracted.cell_id)
    expect(await duration(first.output_artifact_id!)).toBeCloseTo(1, 1)
    await call('pad_video', { asset_id: input.assetId, padding: '2s' })
    await idle()
    await call('run_notebook_cell', { notebook_id: notebookId, cell_id: first.id })
    const rerun = await output(first.id)
    expect(await duration(rerun.output_artifact_id!)).toBeCloseTo(3, 1)
    expect(await duration(first.output_artifact_id!)).toBeCloseTo(1, 1)
  })

  it('recovers a legacy extraction range from the prior output provenance', async () => {
    const input = await source()
    const extracted = await call<Extraction>('extract_notebook_audio', {
      notebook_id: notebookId, source_cell_id: input.cellId, start_seconds: 1, duration_seconds: 0.8,
    })
    const first = await output(extracted.cell_id)
    const legacyInputs = { ...first.inputs }
    delete legacyInputs.audioRange
    await call('update_notebook_cell', { notebook_id: notebookId, cell_id: first.id, cell: { inputs: legacyInputs } })
    await call('run_notebook_cell', { notebook_id: notebookId, cell_id: first.id })
    expect(await duration((await output(first.id)).output_artifact_id!)).toBeCloseTo(0.8, 1)
  })
})
