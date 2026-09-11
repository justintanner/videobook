import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import type { Sequence } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { callTool, startServer, stopServer, type StartedServer } from './mcp-http-test-server.js'

const execFileAsync = promisify(execFile)

interface Job { id: number; state: string; error?: unknown }
interface Asset { artifact_id: string; duration: number | null; media_url: string | null; assetWork: { status: string } | null }

describe('audio mix endpoints over HTTP MCP', () => {
  let rootDir: string
  let server: StartedServer | undefined
  let client: Client
  let bookId: string
  let serial = 0

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-audio-mix-http-'))
    server = await startServer(rootDir)
    client = new Client({ name: 'audio-mix-http-e2e', version: '1' }, {
      capabilities: {}, supportedProtocolVersions: ['2026-07-28'], versionNegotiation: { mode: { pin: '2026-07-28' } },
    })
    await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
    bookId = (await callTool<{ bookId: string }>(client, 'create_book', { name: 'Audio mix fixtures' })).bookId
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
    }, { timeout: 60_000, interval: 100 }).toBe(true)
    expect(current.filter((job) => job.state !== 'done'), JSON.stringify(current)).toEqual([])
  }
  const asset = async (id: string) => (await call<{ assets: Asset[] }>('list_assets')).assets.find((item) => item.artifact_id === id)!
  const bytes = async (id: string, filename: string) => {
    const response = await fetch(`${server!.url.replace('/mcp', '')}/files/${bookId}/${id}/${filename}`)
    expect(response.status).toBe(200)
    return Buffer.from(await response.arrayBuffer())
  }
  const local = async (id: string, filename: string) => {
    const path = join(rootDir, `${++serial}-${filename}`)
    await writeFile(path, await bytes(id, filename))
    return path
  }
  const upload = async (extension: string, duration: number, frequency?: number) => {
    const path = join(rootDir, `fixture-${++serial}.${extension}`)
    const video = extension === 'mp4'
    await execFileAsync(FFMPEG, [
      '-y', ...(video ? ['-f', 'lavfi', '-i', `testsrc2=s=160x96:r=24:d=${duration}`] : []),
      ...(frequency === undefined ? [] : ['-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=${duration}:sample_rate=48000`]),
      ...(video ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p'] : []),
      ...(extension === 'weba' ? ['-f', 'webm', '-c:a', 'libopus'] : []), path,
    ])
    const uploaded = await call<{ assetId: string; processingError?: string }>('upload_file', { filename: `fixture.${extension}`, data: (await readFile(path)).toString('base64') })
    expect(uploaded.processingError).toBeUndefined()
    await idle()
    return uploaded.assetId
  }
  const level = async (id: string, filename: string, frequency: number, start: number, duration: number) => {
    const { stdout } = await execFileAsync(FFMPEG, [
      '-v', 'error', '-ss', String(start), '-i', await local(id, filename), '-t', String(duration),
      '-map', '0:a:0', '-af', `bandpass=f=${frequency}:width_type=h:w=40`, '-ac', '1', '-ar', '8000', '-f', 'f32le', 'pipe:1',
    ], { encoding: 'buffer' })
    let squares = 0
    for (let offset = 0; offset < stdout.length; offset += 4) squares += stdout.readFloatLE(offset) ** 2
    return Math.sqrt(squares / (stdout.length / 4))
  }
  const videoFrames = async (id: string) => (await execFileAsync(FFMPEG, [
    '-v', 'error', '-i', await local(id, 'original.mp4'), '-map', '0:v:0', '-c:v', 'copy', '-f', 'hash', '-hash', 'sha256', 'pipe:1',
  ])).stdout

  it.each(['wav', 'flac', 'weba'])('mixes %s audio and keeps it ready for canonical timeline insertion', async (extension) => {
    const target = await upload(extension, 3, 440)
    const layer = await upload('wav', 1, 880)
    const filename = `original.${extension}`
    const before = await asset(target)
    const layerBefore = await bytes(layer, 'original.wav')
    await call('audio_mix', { target_asset_id: target, layer_asset_id: layer, volume: 50 })
    await idle()
    const probe = await probeVideo(await local(target, filename))
    expect(probe.audioDuration ?? probe.duration).toBeCloseTo(3, 1)
    expect(await level(target, filename, 440, 0.1, 0.6)).toBeGreaterThan(0.04)
    expect(await level(target, filename, 880, 0.1, 0.6)).toBeGreaterThan(0.02)
    expect(await level(target, filename, 880, 2, 0.5)).toBeLessThan(0.003)
    expect(await bytes(layer, 'original.wav')).toEqual(layerBefore)
    const after = await asset(target)
    expect(after.assetWork?.status).toBe('ready')
    expect(after.media_url).not.toBe(before.media_url)
    const streams = await call<Array<{ objectHash: string; kind: string }>>('list_media_streams', { artifact_id: target })
    expect(streams).toEqual(expect.arrayContaining([expect.objectContaining({
      kind: 'audio', objectHash: createHash('sha256').update(await bytes(target, filename)).digest('hex'),
    })]))
    await call('add_timeline_audio', { asset_id: target, start_frame: 0 })
    const sequence = await call<Sequence>('get_primary_sequence')
    expect(sequence.clips[0]!.durationFrames).toBe(90)
  })

  it.each([false, true])('mixes into video with existing audio=%s without changing picture bytes', async (hasAudio) => {
    const target = await upload('mp4', 3, hasAudio ? 440 : undefined)
    const layer = await upload('wav', 5, 880)
    const picture = await videoFrames(target)
    await call('audio_mix', { target_asset_id: target, layer_asset_id: layer, volume: 50 })
    await idle()
    expect(await videoFrames(target)).toBe(picture)
    const output = await probeVideo(await local(target, 'original.mp4'))
    expect(output.videoDuration).toBeCloseTo(3, 2)
    expect(output.audioDuration).toBeCloseTo(3, 1)
    expect(await level(target, 'original.mp4', 880, 2, 0.5)).toBeGreaterThan(0.02)
    await call('set_timeline', { render: 'landscape', slots: [{ artifact_id: target }] })
    expect((await call<Sequence>('get_primary_sequence')).clips[0]!.durationFrames).toBe(90)
  })

  it('rejects a silent layer before queueing or changing the healthy target', async () => {
    const target = await upload('wav', 3, 440)
    const layer = await upload('mp4', 1)
    const before = await asset(target)
    const beforeBytes = await bytes(target, 'original.wav')
    await idle()
    const beforeJobs = await jobs()
    const result = await client.callTool({ name: 'audio_mix', arguments: { book_id: bookId, target_asset_id: target, layer_asset_id: layer, volume: 50 } })
    expect(result.isError).toBe(true)
    expect(await bytes(target, 'original.wav')).toEqual(beforeBytes)
    expect(await jobs()).toEqual(beforeJobs)
    expect((await asset(target)).assetWork).toEqual(before.assetWork)
  })

  it('accepts padded artifact handles and rejects invalid volume without changes', async () => {
    const target = await upload('wav', 2, 440)
    const layer = await upload('wav', 1, 880)
    const before = await bytes(target, 'original.wav')
    const beforeJobs = await jobs()
    const result = await client.callTool({ name: 'audio_mix', arguments: { book_id: bookId, target_asset_id: target, layer_asset_id: layer, volume: 101 } })
    expect(result.isError).toBe(true)
    expect(await bytes(target, 'original.wav')).toEqual(before)
    expect(await jobs()).toEqual(beforeJobs)
    await call('audio_mix', { target_asset_id: ` @${target} `, layer_asset_id: ` @${layer} `, volume: 30 })
    await idle()
    expect(await bytes(target, 'original.wav')).not.toEqual(before)
  })
})
