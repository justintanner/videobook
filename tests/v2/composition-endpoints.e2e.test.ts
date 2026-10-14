import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import sharp from 'sharp'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)

interface Job { id: number; type: string; state: string }
interface Asset { artifact_id: string; assetWork: { status: string } | null; media_url: string | null }
interface Settings { settings: Record<string, Record<string, unknown>> }

describe('composition endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let base: string
  let fixtureId = 0

  const connect = async () => {
    server = await startServer(rootDir)
    base = server.url.replace('/mcp', '')
    client = new Client({ name: 'composition-endpoints-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'],
      versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
  }

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-composition-endpoints-'))
    await connect()
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Composition fixture' })).bookId
  })

  afterEach(async () => {
    await client?.close()
    await stopServer(server)
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 })
  })

  const call = <T>(name: string, args: Record<string, unknown> = {}) => callTool<T>(client, name, { book_id: bookId, ...args })
  const assets = async () => (await call<{ assets: Asset[] }>('list_assets')).assets
  const asset = async (id: string) => (await assets()).find((item) => item.artifact_id === id)!
  const jobs = () => call<Job[]>('list_jobs')
  const idle = async () => {
    let all: Job[] = []
    await expect.poll(async () => {
      all = await jobs()
      return all.every((job) => ['done', 'failed', 'aborted'].includes(job.state))
    }, { timeout: 60_000 }).toBe(true)
    expect(all.filter((job) => job.state !== 'done'), JSON.stringify(all)).toEqual([])
  }
  const file = async (id: string, filename: string) => {
    const response = await fetch(`${base}/files/${bookId}/${id}/${encodeURI(filename)}`)
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
  }
  const localFile = async (id: string, filename: string) => {
    const path = join(rootDir, `${++fixtureId}-${filename}`)
    await writeFile(path, await file(id, filename))
    return path
  }
  const upload = async (filename: string, bytes: Buffer) => {
    const result = await call<{ assetId: string; processingError?: string }>('upload_file', { filename, data: bytes.toString('base64') })
    expect(result.processingError).toBeUndefined()
    await idle()
    return result.assetId
  }
  const picture = async (color = '#ff000080', width = 80, height = 60) => upload('fixture.png', await sharp({ create: { width, height, channels: 4, background: color } }).png().toBuffer())
  const video = async (color = 'black', duration = 3, audioDuration = duration, size = '320x192', fps = 24) => {
    const path = join(rootDir, `video-${++fixtureId}.mp4`)
    await execFileAsync(FFMPEG, ['-y', '-f', 'lavfi', '-i', `color=c=${color}:s=${size}:r=${fps}:d=${duration}`,
      ...(audioDuration > 0 ? ['-f', 'lavfi', '-i', `sine=frequency=440:duration=${audioDuration}`, '-c:a', 'aac'] : []),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', path])
    return upload('fixture.mp4', await readFile(path))
  }
  const frame = async (id: string, seconds: number) => {
    const { stdout } = await execFileAsync(FFMPEG, ['-v', 'error', '-ss', String(seconds), '-i', await localFile(id, 'original.mp4'), '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', 'pipe:1'], { encoding: 'buffer' })
    return stdout
  }
  const pixel = async (bytes: Buffer, x: number, y: number) => [...await sharp(bytes).extract({ left: x, top: y, width: 1, height: 1 }).ensureAlpha().raw().toBuffer()]
  const settings = (id: string) => call<Settings>('get_render_settings', { asset_id: id })
  const rejectWithoutChanges = async (name: string, id: string, args: Record<string, unknown>) => {
    const beforeAssets = await assets()
    await idle()
    const beforeJobs = await jobs()
    const beforeSettings = await settings(id)
    const beforeFile = await file(id, 'original.mp4')
    const result = await client.callTool({ name, arguments: { book_id: bookId, asset_id: id, ...args } })
    expect(result.isError, JSON.stringify(result)).toBe(true)
    expect(await file(id, 'original.mp4')).toEqual(beforeFile)
    expect(await assets()).toEqual(beforeAssets)
    expect(await jobs()).toEqual(beforeJobs)
    expect(await settings(id)).toEqual(beforeSettings)
  }

  it('composes images with padding and explicit empty slots without changing the sources', async () => {
    const red = await picture('red', 80, 40)
    const blue = await picture('blue', 40, 80)
    const original = await file(red, 'original.png')
    const composed = await call<{ asset_id: string; placements: unknown[] }>('concat_images', { image_refs: [red, blue], background: 'white' })
    const bytes = await file(composed.asset_id, 'original.png')
    expect(await sharp(bytes).metadata()).toMatchObject({ width: 1920, height: 1080 })
    expect(await pixel(bytes, 480, 540)).toEqual([255, 0, 0, 255])
    expect(await pixel(bytes, 1440, 540)).toEqual([0, 0, 255, 255])
    expect(await pixel(bytes, 480, 10)).toEqual([255, 255, 255, 255])
    expect(composed.placements).toHaveLength(2)
    const empty = await call<{ asset_id: string }>('concat_images', { image_refs: [null, blue], aspect_ratio: '9:16', background: 'white' })
    expect(await pixel(await file(empty.asset_id, 'original.png'), 540, 300)).toEqual([255, 255, 255, 255])
    expect(await file(red, 'original.png')).toEqual(original)
    expect((await asset(composed.asset_id)).assetWork?.status).toBe('ready')
  })

  it('composes nine cells and rejects invalid backgrounds without creating artifacts', async () => {
    const red = await picture('red')
    const output = await call<{ asset_id: string; placements: unknown[] }>('concat_images', { image_refs: Array<string>(9).fill(red), aspect_ratio: '1:1' })
    expect(output.placements).toHaveLength(9)
    const bytes = await file(output.asset_id, 'original.png')
    for (const x of [180, 540, 900]) for (const y of [180, 540, 900]) expect(await pixel(bytes, x, y)).toEqual([255, 0, 0, 255])
    const before = await assets()
    const rejected = await client.callTool({ name: 'concat_images', arguments: { book_id: bookId, image_refs: [red], background: 'not-a-color' } })
    expect(rejected.isError).toBe(true)
    expect(await assets()).toEqual(before)
  })

  it('inverts colors while preserving transparency and refreshes preview media', async () => {
    const id = await picture()
    const original = await file(id, 'original.png')
    const before = await asset(id)
    await call('invert_image', { asset_id: id })
    await idle()
    expect(await pixel(await file(id, 'original.png'), 20, 20)).toEqual([0, 255, 255, 128])
    expect((await asset(id)).media_url).not.toBe(before.media_url)
    expect(await sharp(await file(id, 'landscape.jpg')).metadata()).toMatchObject({ width: 1920, height: 1080 })
    await call('invert_image', { asset_id: id })
    await idle()
    expect(await sharp(await file(id, 'original.png')).raw().toBuffer()).toEqual(await sharp(original).raw().toBuffer())
  })

  it('normalizes a padded handle before rendering and storing a watermark card', async () => {
    const card = await call<{ asset_id: string; handle: string; url: string }>('create_watermark_card', { handle: '  @cat_test  ', save_default: true })
    expect(card.handle).toBe('cat_test')
    expect(card.url).toBe('https://x.com/cat_test')
    expect(await sharp(await file(card.asset_id, 'original.png')).metadata()).toMatchObject({ format: 'png', hasAlpha: true })
  })

  it('reads the correct book watermark preferences after restarting the server', async () => {
    await call('create_watermark_card', { handle: 'cat_test', save_default: true })
    await call('create_watermark_card', { platform: 'tiktok', handle: 'cat.tiktok', save_default: true })
    expect(await call('get_watermark_config')).toMatchObject({ savedHandle: 'cat_test', recent: ['cat_test'] })
    expect(await call('get_watermark_config', { platform: 'tiktok' })).toMatchObject({ savedHandle: 'cat.tiktok', recent: ['cat.tiktok'], authenticatedHandle: null })
    const other = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Other book' })).bookId
    expect(await call('get_watermark_config', { book_id: other })).toMatchObject({ savedHandle: null, recent: [] })
    expect(await call('get_watermark_config', { book_id: other, platform: 'tiktok' })).toMatchObject({ savedHandle: null, recent: [] })
    await client.close()
    await stopServer(server)
    await connect()
    expect(await call('get_watermark_config')).toMatchObject({ savedHandle: 'cat_test', recent: ['cat_test'] })
    expect(await call('get_watermark_config', { platform: 'tiktok' })).toMatchObject({ savedHandle: 'cat.tiktok', recent: ['cat.tiktok'], authenticatedHandle: null })
  })

  it('burns a timed QR overlay while preserving video and audio duration', async () => {
    const id = await video()
    const badge = await picture('white', 64, 64)
    await call('apply_watermark', { asset_id: id, card_asset_id: badge, include_handle: false, position: 'bottom-right', qr_start_seconds: 1, qr_end_seconds: 2, qr_opacity: 1, fade_seconds: 0 })
    await idle()
    const probe = await probeVideo(await localFile(id, 'original.mp4'))
    expect(probe.videoDuration).toBeCloseTo(3, 1)
    expect(probe.audioDuration).toBeCloseTo(3, 1)
    const means = await Promise.all([0.5, 1.5, 2.5].map(async (time) => (await sharp(await frame(id, time)).stats()).channels[0].mean))
    expect(means[0]).toBeLessThan(1)
    expect(means[1]).toBeGreaterThan(2)
    expect(means[2]).toBeLessThan(1)
    expect((await asset(id)).assetWork?.status).toBe('ready')
  })

  it.each([3, 5])('rejects watermark windows past the picture end with %s seconds of audio', async (audioDuration) => {
    const id = await video('black', 3, audioDuration)
    await rejectWithoutChanges('apply_watermark', id, { include_handle: false, position: 'bottom-right', qr_start_seconds: 3.5, qr_end_seconds: 4.5 })
  })

  it('uses the picture duration for watermark fades when audio lasts longer', async () => {
    const id = await video('black', 3, 5)
    const badge = await picture('white', 64, 64)
    await call('apply_watermark', { asset_id: id, card_asset_id: badge, include_handle: false, position: 'bottom-right', qr_start_seconds: 1, qr_end_seconds: 10, qr_opacity: 1, fade_seconds: 0.5 })
    await idle()
    const probe = await probeVideo(await localFile(id, 'original.mp4'))
    expect(probe.videoDuration).toBeCloseTo(3, 1)
    expect(probe.audioDuration).toBeCloseTo(5, 1)
    expect((await sharp(await frame(id, 2.9)).stats()).channels[0].mean).toBeGreaterThan(2)
  })

  it.each(['qr', 'handle'])('preserves %s-specific timing and opacity in render overlay settings', async (element) => {
    const id = await video()
    await call('apply_watermark', { asset_id: id, handle: '  @cat_test  ', include_handle: element === 'handle', include_qr: element === 'qr', position: 'top-right', mode: 'overlay', [`${element}_start_seconds`]: 1, [`${element}_end_seconds`]: 2, [`${element}_opacity`]: 0.8 })
    const stored = Object.values((await settings(id)).settings)
    expect(stored).toHaveLength(3)
    for (const value of stored) expect(value).toMatchObject({ osgOpacity: 0.8, osgStartSeconds: 1, osgEndSeconds: 2 })
  })

  it('rejects independent windows on a combined render overlay before creating badges', async () => {
    const id = await video()
    await rejectWithoutChanges('apply_watermark', id, { mode: 'overlay', position: 'top-right', qr_start_seconds: 1, qr_end_seconds: 2 })
  })

  it('preserves and accurately reports overlay settings across partial updates and clearing', async () => {
    const id = await video()
    const badge = await picture('white')
    const args = { asset_id: id, osg_asset_id: badge, osg_position: 'top-right', osg_size: 'small' }
    await call('set_video_overlay', { ...args, osg_opacity: 0.35, osg_scale: 0.4, osg_start_seconds: 1, osg_end_seconds: 2 })
    const updated = await call<{ osg: { scale: number; opacity: number } }>('set_video_overlay', { ...args, osg_position: 'bottom-left' })
    expect(updated.osg).toMatchObject({ scale: 0.4, opacity: 0.35 })
    for (const value of Object.values((await settings(id)).settings)) expect(value).toMatchObject({ osgOpacity: 0.35, osgScale: 0.4, osgStartSeconds: 1, osgEndSeconds: 2 })
    await call('set_video_overlay', { ...args, osg_asset_id: null })
    for (const value of Object.values((await settings(id)).settings)) expect(value).toMatchObject({ osgAssetId: null, osgStartSeconds: null, osgEndSeconds: null })
  })

  it('rejects non-image overlays and reversed merged timing without altering render settings', async () => {
    const id = await video()
    const badge = await picture('white')
    const args = { osg_asset_id: badge, osg_position: 'top-right', osg_size: 'small' }
    await call('set_video_overlay', { asset_id: id, ...args, osg_start_seconds: 1, osg_end_seconds: 2 })
    await rejectWithoutChanges('set_video_overlay', id, { ...args, osg_asset_id: id })
    await rejectWithoutChanges('set_video_overlay', id, { ...args, osg_end_seconds: 0.5 })
  })

  it('crossfades differently sized scenes with a silent source and preserves original files', async () => {
    const first = await video('red', 2, 0)
    const second = await video('blue', 3, 3, '96x160', 30)
    const original = await file(first, 'original.mp4')
    const output = await call<{ asset_id: string }>('smooth_scene_concat', { first_asset_id: first, second_asset_id: second, transition_seconds: 0.5 })
    await idle()
    const probe = await probeVideo(await localFile(output.asset_id, 'original.mp4'))
    expect(probe).toMatchObject({ width: 320, height: 192, hasAudio: true })
    expect(probe.videoDuration).toBeCloseTo(4.5, 1)
    expect(probe.audioDuration).toBeCloseTo(4.5, 1)
    expect((await pixel(await frame(output.asset_id, 0.2), 160, 96))[0]).toBeGreaterThan(240)
    expect((await pixel(await frame(output.asset_id, 4.2), 160, 96))[2]).toBeGreaterThan(240)
    expect(await file(first, 'original.mp4')).toEqual(original)
    expect((await asset(output.asset_id)).assetWork?.status).toBe('ready')
  })

  it('rejects scenes too short for a transition before creating a failed output artifact', async () => {
    const first = await video('red', 1 / 24, 0)
    const second = await video('blue', 2, 0)
    await rejectWithoutChanges('smooth_scene_concat', first, { first_asset_id: first, second_asset_id: second })
  })

  it('uses the minimum transition when a short clip can still support a crossfade', async () => {
    const first = await video('red', 2 / 24, 0)
    const second = await video('blue', 2, 0)
    const output = await call<{ asset_id: string }>('smooth_scene_concat', { first_asset_id: first, second_asset_id: second })
    await idle()
    expect((await probeVideo(await localFile(output.asset_id, 'original.mp4'))).videoDuration).toBeCloseTo(2 + 2 / 24 - 0.05, 1)
    expect((await asset(output.asset_id)).assetWork?.status).toBe('ready')
  })
})
