import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElevenLabsSpeechToTextResponse } from '@apicity/elevenlabs'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine } from 'videobook-engine'
import { importElevenLabsTranscript } from '../../server/src/jobs/_transcribe.js'

describe('ElevenLabs transcript import', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('imports exact timed speech, speakers, confidence, and audio events', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-transcript-import-'))
    const engine = createEngine({ durableWrites: false, rootDir: join(rootDir, 'book'),
    initialBookName: 'transcript-import', })
    await engine.ready
    const artifact = await engine.artifacts.create('audio', 'interview')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    const written = await engine.files.write(
      artifact.value.artifactId,
      'original.wav',
      Buffer.from('audio'),
    )
    expect(written.ok).toBe(true)
    if (!written.ok) return
    const manifest = await engine.files.manifest(artifact.value.artifactId)
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    const objectHash = manifest.value.files.find(
      (file) => file.name === 'original.wav',
    )?.objectHash
    expect(objectHash).toBeTruthy()
    if (!objectHash) return
    const stream = await engine.streams.register({
      artifactId: artifact.value.artifactId,
      sourcePath: 'original.wav',
      objectHash,
      streamIndex: 0,
      kind: 'audio',
      timeBase: { numerator: 1, denominator: 48_000 },
      durationTicks: 240_000,
      codec: 'pcm_s16le',
      audio: {
        sampleRateHz: 48_000,
        channels: 2,
        channelLayout: 'stereo',
      },
    })
    expect(stream.ok).toBe(true)
    if (!stream.ok) return
    const response: ElevenLabsSpeechToTextResponse = {
      language_code: 'en',
      language_probability: 0.99,
      text: 'Hello, world. [music]',
      channel_index: 0,
      transcription_id: 'scribe-test',
      audio_duration_secs: 5,
      words: [
        {
          text: 'Hello',
          start: 0.25,
          end: 0.75,
          type: 'word',
          speaker_id: 'speaker-1',
          logprob: Math.log(0.9),
        },
        {
          text: ',',
          start: 0.75,
          end: 0.8,
          type: 'word',
          speaker_id: 'speaker-1',
          logprob: Math.log(0.8),
        },
        {
          text: ' ',
          start: 0.8,
          end: 0.9,
          type: 'spacing',
          speaker_id: 'speaker-1',
        },
        {
          text: 'world.',
          start: 0.9,
          end: 1.4,
          type: 'word',
          speaker_id: 'speaker-1',
          logprob: Math.log(0.7),
        },
        {
          text: '[music]',
          start: 2,
          end: 3,
          type: 'audio_event',
          speaker_id: null,
        },
      ],
    }

    const transcript = await importElevenLabsTranscript(
      engine,
      artifact.value.artifactId,
      response,
      { tagAudioEvents: true, diarize: true },
    )

    expect(transcript.language).toBe('en')
    expect(transcript.provider).toBe('elevenlabs')
    expect(transcript.model).toBe('scribe_v2')
    expect(transcript.segments).toHaveLength(2)
    expect(transcript.segments[0]).toEqual(expect.objectContaining({
      kind: 'speech',
      speaker: 'speaker-1',
      text: 'Hello, world.',
      range: expect.objectContaining({
        startTick: 12_000,
        durationTicks: 55_200,
      }),
      confidence: expect.closeTo(0.8, 5),
    }))
    expect(transcript.segments[0]?.words.map((word) => word.text)).toEqual([
      'Hello',
      ',',
      'world.',
    ])
    expect(transcript.segments[1]).toEqual(expect.objectContaining({
      kind: 'music',
      text: '[music]',
      range: expect.objectContaining({
        startTick: 96_000,
        durationTicks: 48_000,
      }),
    }))
    engine.close()
  })
})
