import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG, FFPROBE, probeVideo } from '../../server/src/ffmpeg.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)

interface Job { id: number; type: string; state: string; result?: { artifactId: string }; error?: unknown }
interface Asset { artifact_id: string; media_url: string | null; duration: number; assetWork: { status: string } | null }

describe('video boundary endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let serial = 0

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-video-boundaries-http-'))
    server = await startServer(rootDir)
    client = new Client({ name: 'video-boundaries-http-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Video boundary fixtures' })).bookId
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, ...args })
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
    }, { timeout: 90_000, interval: 200 }).toBe(true)
    expect(current.filter((job) => job.state !== 'done'), JSON.stringify(current)).toEqual([])
  }
  const asset = async (id: string) => (await call<{ assets: Asset[] }>('list_assets')).assets.find((item) => item.artifact_id === id)!
  const bytes = async (id: string, filename: string) => {
    const response = await fetch(`${server!.url.replace('/mcp', '')}/files/${bookId}/${id}/${filename}`)
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
  }
  const local = async (id: string, filename = 'original.mp4') => {
    const path = join(rootDir, `${++serial}-${filename}`)
    await writeFile(path, await bytes(id, filename))
    return path
  }
  const upload = async (filename: string, data: Buffer) => {
    const result = await call<{ assetId: string; processingError?: string }>('upload_file', { filename, data: data.toString('base64') })
    expect(result.processingError).toBeUndefined()
    await idle()
    return result.assetId
  }
  const video = async (videoDuration = 2, audioDuration?: number) => {
    const path = join(rootDir, `source-${++serial}.mp4`)
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=blue:s=160x96:r=24:d=${videoDuration}`,
      ...(audioDuration === undefined ? [] : ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${audioDuration}:sample_rate=48000`, '-c:a', 'aac']),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path])
    return upload('source.mp4', await readFile(path))
  }
  const picture = () => sharp({ create: { width: 160, height: 96, channels: 3, background: 'red' } }).png().toBuffer().then((data) => upload('image.png', data))
  const frame = async (id: string, seconds: number, filename = 'original.mp4') => {
    const { stdout } = await execFileAsync(FFMPEG, ['-v', 'error', '-ss', String(seconds), '-i', await local(id, filename), '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
    expect(stdout).toHaveLength(3)
    return [...stdout]
  }
  const rms = async (id: string, start: number) => {
    const { stdout } = await execFileAsync(FFMPEG, ['-v', 'error', '-ss', String(start), '-i', await local(id), '-t', '0.2', '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer' })
    expect(stdout.length).toBeGreaterThan(0)
    let squares = 0
    for (let offset = 0; offset < stdout.length; offset += 4) squares += stdout.readFloatLE(offset) ** 2
    return Math.sqrt(squares / (stdout.length / 4))
  }
  const audioHash = async (id: string) => (await execFileAsync(FFMPEG, ['-v', 'error', '-i', await local(id), '-map', '0:a:0', '-c:a', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1'])).stdout
  const frameCount = async (id: string) => Number((await execFileAsync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-count_frames', '-show_entries', 'stream=nb_read_frames', '-of', 'default=noprint_wrappers=1:nokey=1', await local(id)])).stdout)

  it.each([undefined, 2, 4])('pads picture by one second with a silent tail when original audio duration is %s', async (audioDuration) => {
    const id = await video(2, audioDuration)
    const before = await asset(id)
    const padded = await call<{ target_sec: number }>('pad_video', { asset_id: id, padding: '1s' })
    expect(padded.target_sec).toBe(3)
    await idle()
    expect((await probeVideo(await local(id))).videoDuration).toBeCloseTo(3, 2)
    expect((await probeVideo(await local(id, 'proxy.mp4'))).videoDuration).toBeCloseTo(3, 2)
    expect((await frame(id, 1))[2]).toBeGreaterThan(240)
    expect(await frame(id, 2.5)).toEqual([0, 0, 0])
    if (audioDuration !== undefined) {
      expect(await rms(id, 1)).toBeGreaterThan(0.04)
      expect(await rms(id, 2.5)).toBeLessThan(0.001)
    }
    const after = await asset(id)
    expect(after.assetWork?.status).toBe('ready')
    expect(after.media_url).not.toBe(before.media_url)
    expect(after.duration).toBeCloseTo(3, 1)
  })

  it('rejects invalid padding and injected-image targets before creating jobs', async () => {
    const id = await video()
    const image = await picture()
    const before = await bytes(id, 'original.mp4')
    const beforeJobs = await jobs()
    for (const request of [
      { name: 'pad_video', arguments: { asset_id: id, padding: '-1s' } },
      { name: 'inject_first_frame', arguments: { target_asset_id: id, image_asset_id: id } },
      { name: 'inject_first_frame', arguments: { target_asset_id: image, image_asset_id: image } },
      { name: 'inject_first_frame', arguments: { target_asset_id: id, image_asset_id: image, orientation: 'portrait' } },
    ]) {
      const result = await client.callTool({ name: request.name, arguments: { book_id: bookId, ...request.arguments } })
      expect(result.isError).toBe(true)
    }
    expect(await bytes(id, 'original.mp4')).toEqual(before)
    expect(await jobs()).toEqual(beforeJobs)
  })

  it('refreshes the preview when a short pad changes only the final two frames', async () => {
    const id = await video(2.9)
    const padded = await call<{ target_sec: number }>('pad_video', { asset_id: id, padding: '0.01s' })
    expect(padded.target_sec).toBe(3)
    await idle()
    expect((await probeVideo(await local(id))).videoDuration).toBeCloseTo(3, 2)
    expect((await probeVideo(await local(id, 'proxy.mp4'))).videoDuration).toBeCloseTo(3, 2)
    expect(await frame(id, 2.94, 'proxy.mp4')).toEqual([0, 0, 0])
  })

  it('replaces one frame of an uploaded clip while preserving its encoded audio and frame count', async () => {
    const id = await video(2, 2)
    const image = await picture()
    const sound = await audioHash(id)
    const frames = await frameCount(id)
    await call('inject_first_frame', { target_asset_id: ` @${id} `, image_asset_id: image })
    await idle()
    expect((await frame(id, 0))[0]).toBeGreaterThan(240)
    expect((await frame(id, 1 / 24))[2]).toBeGreaterThan(240)
    expect(await frameCount(id)).toBe(frames)
    expect(await audioHash(id)).toBe(sound)
    expect((await frame(id, 0, 'proxy.mp4'))[0]).toBeGreaterThan(240)
  })

  it.each(['landscape', 'square'] as const)('replaces the first frame of a canonical %s export and refreshes its streams', async (orientation) => {
    const id = await video(1, 1)
    const image = await picture()
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: id }] })
    const validation = await call<{ revision: string }>('validate_sequence_export', { sequence_revision: 'current', orientation, captions: 'omit' })
    await call('enqueue_sequence_export', { sequence_revision: validation.revision, orientation, captions: 'omit', confirm: true })
    await idle()
    const final = (await jobs()).find((job) => job.type === 'export_sequence')!.result!.artifactId
    const sound = await audioHash(final)
    const frames = await frameCount(final)
    const secondFrame = await frame(final, 1 / 30)
    expect(secondFrame[2]).toBeGreaterThan(150)
    const before = await bytes(final, 'original.mp4')
    const mismatch = await client.callTool({ name: 'inject_first_frame', arguments: { book_id: bookId, target_asset_id: final, image_asset_id: image, orientation: 'portrait' } })
    expect(mismatch.isError).toBe(true)
    expect(await bytes(final, 'original.mp4')).toEqual(before)
    await call('inject_first_frame', { target_asset_id: final, image_asset_id: image, ...(orientation === 'landscape' ? { orientation } : {}) })
    await idle()
    expect((await frame(final, 0))[0]).toBeGreaterThan(240)
    const preservedFrame = await frame(final, 1 / 30)
    for (let channel = 0; channel < 3; channel++) expect(Math.abs(preservedFrame[channel]! - secondFrame[channel]!)).toBeLessThan(3)
    expect(await frameCount(final)).toBe(frames)
    expect(await audioHash(final)).toBe(sound)
    expect((await sharp(await bytes(final, 'original.jpg')).stats()).channels[0]!.mean).toBeGreaterThan(240)
    const streams = await call<Array<{ objectHash: string; kind: string }>>('list_media_streams', { artifact_id: final })
    expect(streams).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'video', objectHash: createHash('sha256').update(await bytes(final, 'original.mp4')).digest('hex') })]))
  })
})
