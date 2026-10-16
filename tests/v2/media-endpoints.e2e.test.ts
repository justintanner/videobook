import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)

interface Job {
  id: number
  type: string
  payload: Record<string, unknown>
  state: string
  error?: unknown
  result?: { artifactId: string }
}

const MCP_ROUNDTRIP_MS = 15_000

describe('media endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let base: string

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-media-endpoints-'))
    server = await startServer(rootDir)
    base = server.url.replace('/mcp', '')
    client = new Client({ name: 'media-endpoints-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    const book = await callTool<{ bookId: string }>(client, 'create_book', { name: 'Media endpoint fixture' })
    bookId = book.bookId
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, ...args })
  const jobs = () => call<Job[]>('list_jobs')
  const fileUrl = (assetId: string, filename: string) => `${base}/files/${bookId}/${assetId}/${encodeURI(filename)}`
  const file = async (assetId: string, filename: string) => {
    const response = await fetch(fileUrl(assetId, filename))
    expect(response.status, filename).toBe(200)
    return Buffer.from(await response.arrayBuffer())
  }
  const waitForJob = async (type: string, assetId?: string) => {
    let job: Job | undefined
    await expect.poll(async () => {
      job = (await jobs()).find((candidate) => candidate.type === type
        && (assetId === undefined || Object.values(candidate.payload).includes(assetId)))
      return job !== undefined && ['done', 'failed', 'aborted'].includes(job.state)
    }, { timeout: 60_000 }).toBe(true)
    expect(job, JSON.stringify(job)).toMatchObject({ state: 'done' })
    return job!
  }
  const uploadVideo = async (duration = 3, audio = true) => {
    const sourcePath = join(rootDir, `source-${duration}-${audio}.mp4`)
    await execFileAsync(FFMPEG, [
      '-y', '-f', 'lavfi', '-i', `testsrc2=s=160x96:r=24:d=${duration}`,
      ...(audio ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      ...(audio ? ['-c:a', 'aac', '-shortest'] : []), sourcePath,
    ])
    const bytes = await readFile(sourcePath)
    const uploaded = await call<{ assetId: string; processingError?: string }>('upload_file', {
      filename: 'source.mp4', data: bytes.toString('base64'),
    })
    expect(uploaded.processingError).toBeUndefined()
    await expect.poll(async () => (await jobs()).every((job) => ['done', 'failed', 'aborted'].includes(job.state)), { timeout: 60_000 }).toBe(true)
    return { assetId: uploaded.assetId, bytes }
  }
  const probeFile = async (assetId: string, filename: string) => {
    const target = join(rootDir, `${assetId}-${filename.replaceAll('/', '-')}`)
    await writeFile(target, await file(assetId, filename))
    return probeVideo(target)
  }

  it('extracts decodable frames at the start, middle, end and clamped timestamps', async () => {
    const source = await uploadVideo()
    for (const [name, args] of [
      ['extract_frame', { frame: 'first' }], ['extract_frame', { frame: 'last' }],
      ['extract_frame', { timestamp: 1.25 }], ['extract_frame', { timestamp: 3 }],
      ['extract_frame', { timestamp: 99 }],
    ] as const) {
      const extracted = await call<{ image_asset_id: string; job_id: string }>(name, { asset_id: source.assetId, ...args })
      await waitForJob('extract_frame', extracted.image_asset_id)
      const metadata = await sharp(await file(extracted.image_asset_id, 'original.jpg')).metadata()
      expect(metadata).toMatchObject({ width: 160, height: 96, format: 'jpeg' })
    }
    expect(await file(source.assetId, 'original.mp4')).toEqual(source.bytes)
  })

  it('extracts the first frame from a video shorter than the usual first-frame offset', async () => {
    const source = await uploadVideo(1 / 24, false)
    const extracted = await call<{ image_asset_id: string; job_id: string }>('extract_frame', { asset_id: source.assetId, frame: 'first' })
    await waitForJob('extract_frame', extracted.image_asset_id)
    expect(await sharp(await file(extracted.image_asset_id, 'original.jpg')).metadata()).toMatchObject({ width: 160, height: 96 })
  })

  it('rejects unusable audio ranges without creating assets and extracts a valid range', async () => {
    const source = await uploadVideo()
    const before = await call('list_assets')
    const beforeJobs = await jobs()
    for (const start_s of [3, 99]) {
      const result = await client.callTool({ name: 'extract_audio', arguments: {
        book_id: bookId, asset_id: source.assetId, range: { start_s, duration_s: 1 },
      } })
      expect(result.isError, JSON.stringify(result)).toBe(true)
    }
    expect(await call('list_assets')).toEqual(before)
    expect(await jobs()).toEqual(beforeJobs)
    const extracted = await call<{ audio_asset_id: string; job_id: string }>('extract_audio', {
      asset_id: source.assetId, range: { start_s: 0.5, duration_s: 1 },
    })
    await waitForJob('extract_audio', extracted.audio_asset_id)
    const probe = await probeFile(extracted.audio_asset_id, 'original.mp3')
    expect(probe.audioCodec).toBe('mp3')
    expect(probe.duration).toBeGreaterThanOrEqual(1)
    expect(probe.duration).toBeLessThan(1.15)
  })

  it('validates audio destinations before queuing and preserves existing files', async () => {
    const source = await uploadVideo()
    const character = await call<{ asset_id: string }>('create_character', { args: ['Audio destination'] })
    const upload = await fetch(`${base}/api/books/${bookId}/upload?${new URLSearchParams({
      filename: 'Voice.MP3', targetAssetId: character.asset_id,
    })}`, { method: 'POST', body: 'Preserved destination bytes' })
    expect(upload.status).toBe(200)
    const beforeJobs = await jobs()
    for (const filename of ['voice.mp3', './Voice.MP3', '../escape.mp3', '/absolute.mp3', 'wrong.wav']) {
      const result = await client.callTool({ name: 'extract_audio', arguments: {
        book_id: bookId, asset_id: source.assetId,
        destination: { asset_id: character.asset_id, filename },
      } })
      expect(result.isError, filename).toBe(true)
      expect(await jobs(), filename).toEqual(beforeJobs)
      expect((await file(character.asset_id, 'Voice.MP3')).toString()).toBe('Preserved destination bytes')
    }
    const extracted = await call<{ destination: { filename: string } }>('extract_audio', {
      asset_id: source.assetId,
      destination: { asset_id: character.asset_id, filename: 'scenes/voice.mp3' },
      range: { start_s: 1, duration_s: 1 },
    })
    expect(extracted.destination.filename).toBe('scenes/voice.mp3')
    expect((await probeFile(character.asset_id, 'scenes/voice.mp3')).duration).toBeLessThan(1.15)
  })

  it('extracts and splits clips, concatenates them and plays a queued sequence export', async () => {
    const source = await uploadVideo()
    const clip = await call<{ output_asset_id: string; duration: number }>('extract_video_clip', {
      asset_id: source.assetId, start_time: '0.5s', end_time: '2s',
    })
    expect(clip.duration).toBeCloseTo(1.5, 1)
    expect((await probeFile(clip.output_asset_id, 'original.mp4')).duration).toBeCloseTo(1.5, 1)
    const split = await call<{ chunk_a_asset_id: string; chunk_b_asset_id: string }>('split_video', {
      asset_id: source.assetId, chunk_a_end: '1.5s',
    })
    for (const id of [split.chunk_a_asset_id, split.chunk_b_asset_id]) {
      expect((await probeFile(id, 'original.mp4')).duration).toBeCloseTo(1.5, 1)
    }
    const concat = await call<{ asset_id: string; job_id: string }>('smooth_scene_concat', {
      first_asset_id: split.chunk_a_asset_id, second_asset_id: split.chunk_b_asset_id, transition_seconds: 0.25,
    })
    await waitForJob('smooth_scene_concat', concat.asset_id)
    expect((await probeFile(concat.asset_id, 'original.mp4')).duration).toBeCloseTo(2.75, 1)
    await expect.poll(async () => (await jobs()).every((job) => ['done', 'failed', 'aborted'].includes(job.state)), { timeout: 60_000 }).toBe(true)
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: clip.output_asset_id }] })
    const settings = { sequence_revision: 'current', orientation: 'square', captions: 'sidecar' }
    const preview = await call<{ revision: string }>('validate_sequence_export', settings)
    const pinned = { ...settings, sequence_revision: preview.revision }
    const plan = await call<{ validation: { valid: boolean } }>('plan_sequence_export', {
      ...pinned, actor: 'e2e', source_surface: 'ui',
    })
    expect(plan.validation.valid).toBe(true)
    const queued = await call<{ jobId: string }>('enqueue_sequence_export', { ...pinned, confirm: true })
    expect(queued.jobId).toBeTruthy()
    const job = await waitForJob('export_sequence')
    const finalId = job.result!.artifactId
    const finalProbe = await probeFile(finalId, 'original.mp4')
    expect(finalProbe).toMatchObject({ width: 1080, height: 1080, videoCodec: 'h264', audioCodec: 'aac' })
    expect(finalProbe.duration).toBeCloseTo(1.5, 1)
    expect((await file(finalId, 'captions.vtt')).toString()).toMatch(/^WEBVTT/u)
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(fileUrl(finalId, 'original.mp4'))
      const video = page.locator('video')
      await expect.poll(() => video.evaluate((media) => (media as HTMLVideoElement).duration), { timeout: MCP_ROUNDTRIP_MS }).toBeCloseTo(1.5, 1)
      await video.evaluate(async (media) => { (media as HTMLVideoElement).muted = true; await (media as HTMLVideoElement).play() })
      await expect.poll(() => video.evaluate((media) => (media as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    } finally { await browser.close() }
    expect(await file(source.assetId, 'original.mp4')).toEqual(source.bytes)
  })

  it('rejects conflicting split destinations and persists valid nested chunks', async () => {
    const source = await uploadVideo(3, false)
    const destination = await call<{ asset_id: string }>('create_character', { args: ['Split destination'] })
    const uploaded = await fetch(`${base}/api/books/${bookId}/upload?${new URLSearchParams({
      filename: 'Taken.MP4', targetAssetId: destination.asset_id,
    })}`, { method: 'POST', body: 'Preserved destination bytes' })
    expect(uploaded.status).toBe(200)
    const beforeJobs = await jobs()
    for (const filenames of [
      ['same.mp4', './same.mp4'], ['taken.mp4', 'fresh.mp4'],
      ['../escape.mp4', 'fine.mp4'], ['nested.mp4', 'nested.mp4/part.mp4'],
      ['wrong.jpg', 'fine.mp4'],
    ]) {
      const result = await client.callTool({ name: 'split_video_by_durations', arguments: {
        book_id: bookId, asset_id: source.assetId, target_secs: [1.5, 1.5],
        destination: { asset_id: destination.asset_id, filenames },
      } })
      expect(result.isError, filenames.join(', ')).toBe(true)
      expect(await jobs()).toEqual(beforeJobs)
      expect((await file(destination.asset_id, 'Taken.MP4')).toString()).toBe('Preserved destination bytes')
    }
    await call('split_video_by_durations', {
      asset_id: source.assetId, target_secs: [1.5, 1.5],
      destination: { asset_id: destination.asset_id, filenames: ['parts/a.mp4', 'parts/b.mp4'] },
    })
    await waitForJob('even_split')
    for (const filename of ['parts/a.mp4', 'parts/b.mp4']) {
      expect((await probeFile(destination.asset_id, filename)).videoDuration).toBeCloseTo(1.5, 1)
    }
  })

  it('prevents concurrent audio extractions from overwriting the same destination', async () => {
    const source = await uploadVideo()
    const destination = await call<{ asset_id: string }>('create_character', { args: ['Concurrent destination'] })
    const args = {
      book_id: bookId, asset_id: source.assetId,
      destination: { asset_id: destination.asset_id, filename: 'shared.mp3' },
    }
    const results = await Promise.all([0, 2].map((start_s) => client.callTool({
      name: 'extract_audio', arguments: { ...args, range: { start_s, duration_s: 1 } },
    })))
    expect(results.filter((result) => result.isError), JSON.stringify(results)).toHaveLength(1)
    const bytes = await file(destination.asset_id, 'shared.mp3')
    const probe = await probeFile(destination.asset_id, 'shared.mp3')
    expect(probe.audioCodec).toBe('mp3')
    expect(probe.duration).toBeGreaterThanOrEqual(1)
    expect(probe.duration).toBeLessThan(1.15)
    const rejected = await client.callTool({ name: 'extract_audio', arguments: args })
    expect(rejected.isError).toBe(true)
    expect(await file(destination.asset_id, 'shared.mp3')).toEqual(bytes)
    const { assets } = await call<{ assets: Array<{ artifact_id: string; assetWork: { status: string } | null }> }>('list_assets')
    expect(assets.find((asset) => asset.artifact_id === destination.asset_id)?.assetWork?.status).not.toBe('error')
  })
})
