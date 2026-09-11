import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { chromium } from 'playwright'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG, FFPROBE, probeVideo } from '../../server/src/ffmpeg.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)

interface Job {
  id: number
  type: string
  state: string
  error?: unknown
}

interface Uploaded {
  assetId: string
  processingError?: string
}

interface ListedAsset {
  artifact_id: string
  duration: number | null
  media_url: string | null
  assetWork: { status: string } | null
}

describe('transformation endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let base: string
  let fixtureId = 0

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-transform-endpoints-'))
    server = await startServer(rootDir)
    base = server.url.replace('/mcp', '')
    client = new Client({ name: 'transform-endpoints-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Transformation fixture' })).bookId
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, ...args })
  const jobs = () => call<Job[]>('list_jobs')
  const idle = async () => {
    let all: Job[] = []
    await expect.poll(async () => {
      all = await jobs()
      return all.every((job) => ['done', 'failed', 'aborted'].includes(job.state))
    }, { timeout: 60_000 }).toBe(true)
    expect(all.filter((job) => job.state !== 'done'), JSON.stringify(all)).toEqual([])
  }
  const asset = async (id: string) => (await call<{ assets: ListedAsset[] }>('list_assets')).assets.find((item) => item.artifact_id === id)!
  const fileUrl = (id: string, filename: string) => `${base}/files/${bookId}/${id}/${encodeURI(filename)}`
  const file = async (id: string, filename: string) => {
    const response = await fetch(fileUrl(id, filename))
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
  }
  const localFile = async (id: string, filename: string) => {
    const path = join(rootDir, `${++fixtureId}-${filename}`)
    await writeFile(path, await file(id, filename))
    return path
  }
  const probe = async (id: string, filename: string) => probeVideo(await localFile(id, filename))
  const upload = async (filename: string, bytes: Buffer) => {
    const result = await call<Uploaded>('upload_file', { filename, data: bytes.toString('base64') })
    expect(result.processingError).toBeUndefined()
    await idle()
    return result.assetId
  }
  const video = async (audio = true, extension = 'mp4') => {
    const path = join(rootDir, `fixture-${++fixtureId}.${extension}`)
    await execFileAsync(FFMPEG, [
      '-y', '-f', 'lavfi', '-i', 'color=c=red:s=160x96:r=24:d=1.5',
      '-f', 'lavfi', '-i', 'color=c=blue:s=160x96:r=24:d=1.5',
      ...(audio ? ['-f', 'lavfi', '-i', 'sine=frequency=440:duration=3'] : []),
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]', '-map', '[v]',
      ...(audio ? ['-map', '2:a', '-c:a', extension === 'webm' ? 'libopus' : 'aac'] : []),
      '-c:v', extension === 'webm' ? 'libvpx-vp9' : 'libx264', '-pix_fmt', 'yuv420p', path,
    ])
    return upload(`fixture.${extension}`, await readFile(path))
  }
  const audio = async (duration = 3, extension = 'wav') => {
    const path = join(rootDir, `fixture-${++fixtureId}.${extension}`)
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `sine=frequency=880:duration=${duration}`, '-af', 'volume=0.5', ...(extension === 'weba' ? ['-f', 'webm', '-c:a', 'libopus'] : []), path])
    return upload(`fixture.${extension}`, await readFile(path))
  }
  const picture = async () => {
    const blue = await sharp({ create: { width: 80, height: 96, channels: 3, background: 'blue' } }).png().toBuffer()
    return upload('fixture.png', await sharp({ create: { width: 160, height: 96, channels: 3, background: 'red' } })
      .composite([{ input: blue, left: 80, top: 0 }]).png().toBuffer())
  }
  const frame = async (id: string, seconds: number, filename = 'original.mp4') => {
    const { stdout } = await execFileAsync(FFMPEG, ['-v', 'error', '-ss', String(seconds), '-i', await localFile(id, filename), '-frames:v', '1', '-vf', 'scale=1:1', '-pix_fmt', 'rgb24', '-f', 'rawvideo', 'pipe:1'], { encoding: 'buffer' })
    return [...stdout]
  }
  const frameCount = async (id: string) => {
    const { stdout } = await execFileAsync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'json', await localFile(id, 'original.mp4')])
    return Number((JSON.parse(stdout) as { streams: Array<{ nb_frames: string }> }).streams[0].nb_frames)
  }
  const rms = async (id: string, filename: string) => {
    const { stdout } = await execFileAsync(FFMPEG, ['-v', 'error', '-i', await localFile(id, filename), '-map', '0:a:0', '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1'], { encoding: 'buffer' })
    let squares = 0
    for (let offset = 0; offset < stdout.length; offset += 4) squares += stdout.readFloatLE(offset) ** 2
    return Math.sqrt(squares / (stdout.length / 4))
  }
  const rejectWithoutChanges = async (name: string, id: string, filename: string, args: Record<string, unknown>) => {
    const beforeFile = await file(id, filename)
    const before = await asset(id)
    await idle()
    const beforeJobs = await jobs()
    const result = await client.callTool({ name, arguments: { book_id: bookId, asset_id: id, ...args } })
    expect(result.isError, JSON.stringify(result)).toBe(true)
    expect(await file(id, filename)).toEqual(beforeFile)
    expect((await asset(id)).assetWork).toEqual(before.assetWork)
    expect(await jobs()).toEqual(beforeJobs)
  }

  it('reverses, changes speed and crops a video while refreshing playable media', async () => {
    const id = await video()
    const before = await asset(id)
    expect((await frame(id, 0))[0]).toBeGreaterThan(200)
    await call('reverse_video', { asset_id: id })
    await idle()
    expect((await frame(id, 0))[2]).toBeGreaterThan(200)
    expect((await frame(id, 2.8))[0]).toBeGreaterThan(200)
    await call('change_video_speed', { asset_id: id, speed: 2 })
    await idle()
    expect((await probe(id, 'original.mp4')).videoDuration).toBeCloseTo(1.5, 1)
    expect(await frameCount(id)).toBe(72)
    await call('change_video_speed', { asset_id: id, target_duration_seconds: 3 })
    await idle()
    expect((await probe(id, 'original.mp4')).videoDuration).toBeCloseTo(3, 1)
    expect(await frameCount(id)).toBe(72)
    await call('crop_video', { asset_id: id, ratio: '1:1', x: 0.2, y: 0, w: 0.6, h: 1 })
    await idle()
    expect(await probe(id, 'original.mp4')).toMatchObject({ width: 1080, height: 1080, hasAudio: true })
    const after = await asset(id)
    expect(after.media_url).not.toBe(before.media_url)
    expect(after.assetWork?.status).toBe('ready')
    expect(after.duration).toBeCloseTo(3, 1)
    const browser = await chromium.launch({ headless: true })
    try {
      const page = await browser.newPage()
      await page.goto(new URL(after.media_url!, base).href)
      const media = page.locator('video')
      await expect.poll(() => media.evaluate((element) => (element as HTMLVideoElement).duration)).toBeCloseTo(3, 1)
      await media.evaluate(async (element) => { const video = element as HTMLVideoElement; video.muted = true; await video.play() })
      await expect.poll(() => media.evaluate((element) => (element as HTMLVideoElement).currentTime)).toBeGreaterThan(0)
    } finally { await browser.close() }
  })

  it('crops a PNG to the selected region and rejects incompatible crop geometry without changing status', async () => {
    const id = await picture()
    await rejectWithoutChanges('crop_image', id, 'original.png', { ratio: '1:1', x: 0, y: 0, w: 1, h: 1 })
    await call('crop_image', { asset_id: id, ratio: '1:1', x: 0.5, y: 0, w: 0.5, h: 80 / 96 })
    await idle()
    const cropped = sharp(await file(id, 'original.jpg'))
    expect(await cropped.metadata()).toMatchObject({ width: 1080, height: 1080 })
    const channels = (await cropped.stats()).channels
    expect(channels[2].mean).toBeGreaterThan(240)
    expect(channels[0].mean).toBeLessThan(10)
  })

  it('rejects incompatible video crops before creating a failed job', async () => {
    const id = await video()
    await rejectWithoutChanges('crop_video', id, 'original.mp4', { ratio: '1:1', x: 0, y: 0, w: 1, h: 1 })
  })

  it('replaces audio with a shorter source without truncating picture', async () => {
    const id = await video()
    const soundtrack = await audio(1)
    const soundtrackBytes = await file(soundtrack, 'original.wav')
    await call('replace_video_audio', { asset_id: id, audio_asset_id: soundtrack })
    await idle()
    const output = await probe(id, 'original.mp4')
    expect(output.videoDuration).toBeCloseTo(3, 1)
    expect(output.audioDuration).toBeCloseTo(3, 1)
    expect((await frame(id, 2.8))[2]).toBeGreaterThan(200)
    expect(await file(soundtrack, 'original.wav')).toEqual(soundtrackBytes)
  })

  it('rejects replacement sources without audio while preserving the video', async () => {
    const id = await video()
    const silent = await video(false)
    await rejectWithoutChanges('replace_video_audio', id, 'original.mp4', { audio_asset_id: `${silent}/original.mp4` })
    await rejectWithoutChanges('audio_boost', silent, 'original.mp4', { boost: 2 })
  })

  it('replaces audio on an uploaded WebM without changing its archived source or duration', async () => {
    const id = await video(false, 'webm')
    const soundtrack = await audio(5)
    const uploadedSource = await file(id, 'original.webm')
    await call('replace_video_audio', { asset_id: id, audio_asset_id: soundtrack })
    await idle()
    const output = await probe(id, 'original.mp4')
    expect(output.videoDuration).toBeCloseTo(3, 1)
    expect(output.audioDuration).toBeCloseTo(3, 1)
    expect(output.audioCodec).toBe('aac')
    expect(await file(id, 'original.webm')).toEqual(uploadedSource)
    expect((await frame(id, 2.8))[2]).toBeGreaterThan(200)
  })

  it('trims and boosts WAV audio without changing its encoding or losing timeline readiness', async () => {
    const id = await audio()
    await call('trim_audio', { asset_id: id, trim_start: 0.5, trim_end: 2.5 })
    expect((await probe(id, 'original.wav')).duration).toBeCloseTo(2, 2)
    expect((await asset(id)).duration).toBeCloseTo(2, 2)
    await call('trim_audio', { asset_id: id, cut_start: 0.5, cut_end: 1.5 })
    expect((await probe(id, 'original.wav')).duration).toBeCloseTo(1, 2)
    const level = await rms(id, 'original.wav')
    await call('audio_boost', { asset_id: id, boost: 2 })
    await idle()
    expect((await probe(id, 'original.wav')).audioCodec).toBe('pcm_s16le')
    expect((await rms(id, 'original.wav')) / level).toBeCloseTo(2, 1)
    const timeline = await call<{ clip: { durationFrames: number } }>('add_timeline_audio', { asset_id: id, start_frame: 0 })
    expect(timeline.clip.durationFrames).toBe(30)
  })

  it('rejects empty or out-of-range audio trims before affecting the artifact', async () => {
    const id = await audio()
    await rejectWithoutChanges('trim_audio', id, 'original.wav', { trim_start: 3, trim_end: 4 })
    await rejectWithoutChanges('trim_audio', id, 'original.wav', { cut_start: 0, cut_end: 3 })
  })

  it.each([['flac', 'flac'], ['ogg', 'vorbis'], ['weba', 'opus']])('boosts %s audio with a compatible codec and measurable gain', async (extension, codec) => {
    const id = await audio(1, extension)
    const filename = `original.${extension}`
    const before = await rms(id, filename)
    await call('audio_boost', { asset_id: id, boost: 2 })
    await idle()
    const output = await probe(id, filename)
    expect(output.audioCodec).toBe(codec)
    expect(output.duration).toBeCloseTo(1, 1)
    expect((await rms(id, filename)) / before).toBeCloseTo(2, 1)
  })

  it('mixes a short audio layer into silent video and audio while preserving their durations', async () => {
    const layer = await audio(1)
    const silent = await video(false)
    const target = await audio()
    const originalLayer = await file(layer, 'original.wav')
    await call('audio_mix', { target_asset_id: silent, layer_asset_id: layer, volume: 50 })
    await idle()
    expect(await probe(silent, 'original.mp4')).toMatchObject({ hasAudio: true, videoDuration: 3 })
    await call('audio_mix', { target_asset_id: target, layer_asset_id: layer, volume: 50 })
    await idle()
    expect(await probe(target, 'original.wav')).toMatchObject({ audioCodec: 'pcm_s16le', duration: 3 })
    expect(await file(layer, 'original.wav')).toEqual(originalLayer)
    const timeline = await call<{ clip: { durationFrames: number } }>('add_timeline_audio', { asset_id: target, start_frame: 0 })
    expect(timeline.clip.durationFrames).toBe(90)
  })

  it('retimes a selected range while preserving full duration and audio', async () => {
    const id = await video()
    const originalLevel = await rms(id, 'original.mp4')
    await call('timewarp_video', { asset_id: id, start_seconds: 0.5, end_seconds: 1.5, stretch_factor: 1.5 })
    await idle()
    expect((await probe(id, 'original.mp4')).videoDuration).toBeCloseTo(3, 1)
    expect((await rms(id, 'original.mp4')) / originalLevel).toBeCloseTo(1, 2)
  })

  it('preserves variable frame spacing when requesting an exact duration', async () => {
    const path = join(rootDir, 'variable.mp4')
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', 'testsrc2=s=160x96:r=24:d=3', '-vf', "select='if(lt(t,1.5),not(mod(n,2)),1)'", '-fps_mode', 'vfr', '-c:v', 'libx264', path])
    const id = await upload('variable.mp4', await readFile(path))
    const count = await frameCount(id)
    await call('change_video_speed', { asset_id: id, target_duration_seconds: 6 })
    await idle()
    expect(await frameCount(id)).toBe(count)
    expect(Math.abs((await probe(id, 'original.mp4')).videoDuration - 6)).toBeLessThan(0.1)
    const { stdout } = await execFileAsync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=pts_time', '-of', 'json', await localFile(id, 'original.mp4')])
    const times = (JSON.parse(stdout) as { packets: Array<{ pts_time: string }> }).packets.map((packet) => Number(packet.pts_time)).sort((a, b) => a - b)
    const earlyInterval = times[3] - times[2]
    const lateInterval = times.at(-3)! - times.at(-4)!
    expect(earlyInterval / lateInterval).toBeCloseTo(2, 1)
  })
})
