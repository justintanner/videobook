import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine } from 'videobook-engine'
import { processVideoFiles } from '../../server/src/jobs/process-video.js'
import { FFMPEG, probeVideo } from '../../server/src/ffmpeg.js'
import { buildAssetList } from '../../server/src/tools/sync.js'

const execFileAsync = promisify(execFile)

describe('video ingest stream identity', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  it('registers exact video and audio stream profiles for uploaded media', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-video-streams-'))
    const sourcePath = join(rootDir, 'incoming.mp4')
    await execFileAsync(FFMPEG, [
      '-y',
      '-f', 'lavfi', '-i', 'testsrc=duration=1:size=320x240:rate=24',
      '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-shortest',
      sourcePath,
    ])
    const engine = createEngine({
      rootDir: join(rootDir, 'book'),
      initialBookSlug: 'video-streams',
    })
    await engine.ready
    const artifact = await engine.artifacts.create('video', 'source-video')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return

    await processVideoFiles(engine, {
      type: 'process_video',
      videoPath: sourcePath,
      assetId: artifact.value.artifactId,
      assetDir: artifact.value.path,
      bookId: engine.book.get().bookId,
      provenance: { origin: 'integration-test' },
      skipDownstreamJobs: true,
    })

    const streams = engine.streams.list(artifact.value.artifactId)
    expect(streams.ok).toBe(true)
    if (!streams.ok) return
    expect(streams.value).toHaveLength(2)
    expect(streams.value.find((stream) => stream.kind === 'video')).toMatchObject({
      sourcePath: 'incoming.mp4',
      streamIndex: 0,
      codec: 'h264',
      video: {
        width: 320,
        height: 240,
        pixelAspect: { numerator: 1, denominator: 1 },
        nominalFrameRate: { numerator: 24, denominator: 1 },
      },
    })
    expect(streams.value.find((stream) => stream.kind === 'audio')).toMatchObject({
      sourcePath: 'incoming.mp4',
      streamIndex: 1,
      codec: 'aac',
      audio: {
        sampleRateHz: 48_000,
        channels: 1,
        channelLayout: 'mono',
      },
    })
    for (const stream of streams.value) {
      expect(stream.durationTicks).toBeGreaterThan(0)
      expect(stream.objectHash).toMatch(/^[a-f0-9]{64}$/)
    }
    const manifest = await engine.files.manifest(artifact.value.artifactId)
    expect(manifest.ok).toBe(true)
    if (manifest.ok) {
      const proxy = manifest.value.files.find((file) => file.name === 'proxy.mp4')
      expect(proxy).toBeTruthy()
      if (proxy) {
        const proxyProfile = await probeVideo(join(manifest.value.path, proxy.name))
        expect(proxyProfile.width).toBeLessThanOrEqual(1280)
        expect(proxyProfile.height).toBeLessThanOrEqual(720)
      }
    }
    const projected = await buildAssetList(engine, engine.book.get().bookId)
    expect(projected[0]?.media_url).toContain('/proxy.mp4')
    engine.close()
  })
})
