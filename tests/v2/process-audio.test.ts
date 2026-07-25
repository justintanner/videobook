import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine } from 'videobook-engine'
import { FFMPEG } from '../../server/src/ffmpeg.js'
import { processAudioFile } from '../../server/src/jobs/process-audio.js'

const execFileAsync = promisify(execFile)

describe('audio ingest', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  it('registers an audio stream and waveform from real media', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-audio-ingest-'))
    const sourcePath = join(rootDir, 'recording.wav')
    await execFileAsync(FFMPEG, [
      '-y',
      '-f', 'lavfi',
      '-i', 'sine=frequency=440:duration=1:sample_rate=48000',
      sourcePath,
    ])
    const engine = createEngine({
      rootDir: join(rootDir, 'book'),
      initialBookSlug: 'audio-ingest',
    })
    await engine.ready
    const artifact = await engine.artifacts.create('audio', 'recording')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect((await engine.files.writeFromPath(
      artifact.value.artifactId,
      'original.wav',
      sourcePath,
    )).ok).toBe(true)

    const result = await processAudioFile(engine, {
      type: 'process_audio',
      audioPath: sourcePath,
      sourceFilename: 'original.wav',
      assetId: artifact.value.artifactId,
      assetDir: artifact.value.path,
      bookId: engine.book.get().bookId,
      provenance: { origin: 'microphone-test' },
    })

    expect(result.duration).toBeCloseTo(1, 1)
    const streams = engine.streams.list(artifact.value.artifactId)
    expect(streams.ok).toBe(true)
    if (!streams.ok) return
    expect(streams.value).toEqual([
      expect.objectContaining({
        kind: 'audio',
        sourcePath: 'original.wav',
        timeBase: { numerator: 1, denominator: 48_000 },
        audio: {
          sampleRateHz: 48_000,
          channels: 1,
          channelLayout: 'mono',
        },
      }),
    ])
    const waveform = await engine.metadata.waveforms.read(artifact.value.artifactId)
    expect(waveform.ok).toBe(true)
    if (waveform.ok) expect(waveform.value.peaks.length).toBeGreaterThan(0)
    engine.close()
  })
})
