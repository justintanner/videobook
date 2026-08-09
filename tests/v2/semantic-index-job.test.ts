import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { createEngine } from 'videobook-engine'
import {
  commitDeepBatches,
  indexArtifact,
  runSemanticIndex,
} from '../../server/src/jobs/semantic-index.js'
import type { JobHandlerContext } from '../../server/src/queue.js'

describe('progressive semantic index job', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  it('indexes bounded scene text and exact frame references with real engine storage', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-index-job-'))
    const engine = createEngine({ rootDir, initialBookName: 'index-job' })
    await engine.ready
    const created = await engine.artifacts.create('video', 'red-van')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const artifactId = created.value.artifactId
    expect((await engine.files.write(
      artifactId,
      'original.mp4',
      Buffer.from('video-source'),
    )).ok).toBe(true)
    expect((await engine.files.write(
      artifactId,
      'original_frames/0.00.jpg',
      Buffer.from('frame-zero'),
    )).ok).toBe(true)
    expect((await engine.files.write(
      artifactId,
      'original_frames/5.00.jpg',
      Buffer.from('frame-five'),
    )).ok).toBe(true)
    expect((await engine.files.write(
      artifactId,
      '.original.analysis.json',
      JSON.stringify({
        summary: 'A delivery van enters a sunny yard',
        scenes: [
          { timestamp: 0, description: 'Empty driveway' },
          { timestamp: 5, description: 'The red van crosses the gate' },
        ],
        textOnScreen: ['FAST DELIVERY'],
      }),
    )).ok).toBe(true)
    const manifest = await engine.files.manifest(artifactId)
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    const source = manifest.value.files.find((file) => file.name === 'original.mp4')
    expect(source).toBeTruthy()
    if (!source) return
    const stream = await engine.streams.register({
      artifactId,
      sourcePath: source.name,
      objectHash: source.objectHash,
      streamIndex: 0,
      kind: 'video',
      timeBase: { numerator: 1, denominator: 1_000 },
      durationTicks: 10_000,
      codec: 'h264',
      video: {
        width: 1920,
        height: 1080,
        rotationDegrees: 0,
        pixelAspect: { numerator: 1, denominator: 1 },
      },
    })
    expect(stream.ok).toBe(true)
    if (!stream.ok) return

    const indexed = await indexArtifact(engine, artifactId)
    expect(indexed.observationCount).toBe(2)
    const described = await engine.temporalSearch.query({
      text: 'red van crosses gate',
      limit: 5,
    })
    expect(described.ok).toBe(true)
    if (!described.ok) return
    expect(described.value.hits[0]).toMatchObject({
      artifactId,
      location: {
        kind: 'timed',
        range: { startTick: 5_000, durationTicks: 5_000 },
      },
    })
    expect(described.value.hits[0]?.signals).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'metadata' })]),
    )
    const reverse = await engine.temporalSearch.query({
      reference: {
        kind: 'frame',
        source: {
          streamId: stream.value.streamId,
          objectHash: source.objectHash,
          tick: 5_500,
          timeBase: stream.value.timeBase,
        },
      },
      limit: 5,
    })
    expect(reverse.ok).toBe(true)
    if (!reverse.ok) return
    expect(reverse.value.hits[0]).toMatchObject({
      artifactId,
      location: {
        kind: 'timed',
        range: { startTick: 5_000 },
      },
    })
    expect(reverse.value.hits[0]?.signals).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: 'exact' })]),
    )
    expect(engine.temporalSearch.coverage(artifactId)).toMatchObject({
      ok: true,
      value: { state: 'ready', partialResults: false },
    })
    engine.close()
  })

  it('indexes corrected typed transcript segments at their exact source ranges', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-index-transcript-'))
    const engine = createEngine({ rootDir, initialBookName: 'index-transcript' })
    await engine.ready
    const created = await engine.artifacts.create('audio', 'interview')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect((await engine.files.write(
      created.value.artifactId,
      'original.wav',
      Buffer.from('audio-source'),
    )).ok).toBe(true)
    const manifest = await engine.files.manifest(created.value.artifactId)
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    const source = manifest.value.files[0]
    expect(source).toBeTruthy()
    if (!source) return
    const stream = await engine.streams.register({
      artifactId: created.value.artifactId,
      sourcePath: source.name,
      objectHash: source.objectHash,
      streamIndex: 0,
      kind: 'audio',
      timeBase: { numerator: 1, denominator: 48_000 },
      durationTicks: 240_000,
      codec: 'pcm_s16le',
      audio: {
        sampleRateHz: 48_000,
        channels: 1,
        channelLayout: 'mono',
      },
    })
    expect(stream.ok).toBe(true)
    if (!stream.ok) return
    expect((await engine.transcripts.import({
      artifactId: created.value.artifactId,
      streamId: stream.value.streamId,
      objectHash: source.objectHash,
      language: 'en',
      provider: 'human',
      segments: [{
        ordinal: 0,
        range: {
          streamId: stream.value.streamId,
          objectHash: source.objectHash,
          startTick: 96_000,
          durationTicks: 48_000,
          timeBase: stream.value.timeBase,
        },
        speaker: 'A',
        text: 'corrected launch phrase',
        kind: 'speech',
        words: [],
      }],
    })).ok).toBe(true)

    const indexed = await indexArtifact(engine, created.value.artifactId)
    expect(indexed.observationCount).toBe(2)
    const found = await engine.temporalSearch.query({
      text: '"corrected launch phrase"',
      modalities: ['speech'],
      limit: 5,
    })
    expect(found.ok).toBe(true)
    if (!found.ok) return
    expect(found.value.hits[0]).toMatchObject({
      artifactId: created.value.artifactId,
      location: {
        kind: 'timed',
        range: {
          startTick: 96_000,
          durationTicks: 48_000,
        },
      },
    })
    engine.close()
  })

  it('resumes deep model batches from the durable cursor after interruption', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-index-resume-'))
    const engine = createEngine({ rootDir, initialBookName: 'index-resume' })
    await engine.ready
    const created = await engine.artifacts.create('video', 'resume-source')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    expect((await engine.files.write(
      created.value.artifactId,
      'original.mp4',
      Buffer.from('resume-video'),
    )).ok).toBe(true)
    const files = await engine.files.manifest(created.value.artifactId)
    expect(files.ok).toBe(true)
    if (!files.ok) return
    const source = files.value.files[0]
    expect(source).toBeTruthy()
    if (!source) return
    const stream = await engine.streams.register({
      artifactId: created.value.artifactId,
      sourcePath: source.name,
      objectHash: source.objectHash,
      streamIndex: 0,
      kind: 'video',
      timeBase: { numerator: 1, denominator: 1_000 },
      durationTicks: 10_000,
      codec: 'h264',
      video: {
        width: 1920,
        height: 1080,
        rotationDegrees: 0,
        pixelAspect: { numerator: 1, denominator: 1 },
      },
    })
    expect(stream.ok).toBe(true)
    if (!stream.ok) return
    const resumeManifest = {
      manifestId: 'resume-model-v1',
      provider: 'fixture',
      modelId: 'fixture',
      modelRevision: '1',
      embeddingSpace: 'resume-space',
      dimensions: 1,
      modalities: ['visual' as const],
      supportedLanguages: ['en'],
      preprocessingVersion: '1',
      extractorVersion: '1',
      createdAt: 1,
    }
    expect(engine.temporalSearch.manifests.register(resumeManifest).ok).toBe(true)
    const options = {
      artifactId: created.value.artifactId,
      objectHash: source.objectHash,
      manifestId: resumeManifest.manifestId,
      generation: 'resume-generation',
      phase: 'visual' as const,
      totalUnits: 10,
    }
    const firstStarts: number[] = []
    await expect(commitDeepBatches(
      engine,
      options,
      async (start, end) => {
        firstStarts.push(start)
        if (start === 4) throw new Error('simulated interruption')
        return observationsForRange(
          created.value.artifactId,
          source.objectHash,
          stream.value.streamId,
          start,
          end,
        )
      },
    )).rejects.toThrow('simulated interruption')
    expect(firstStarts).toEqual([0, 4])
    expect(engine.temporalSearch.plan(
      created.value.artifactId,
      source.objectHash,
      resumeManifest.manifestId,
      options.generation,
    )).toMatchObject({
      ok: true,
      value: {
        coverage: [expect.objectContaining({
          indexedUnits: 4,
          nextCursor: '4',
          state: 'partial',
        })],
      },
    })
    const resumedStarts: number[] = []
    await commitDeepBatches(engine, options, async (start, end) => {
      resumedStarts.push(start)
      return observationsForRange(
        created.value.artifactId,
        source.objectHash,
        stream.value.streamId,
        start,
        end,
      )
    })
    expect(resumedStarts).toEqual([4, 8])
    expect(engine.temporalSearch.plan(
      created.value.artifactId,
      source.objectHash,
      resumeManifest.manifestId,
      options.generation,
    )).toMatchObject({
      ok: true,
      value: {
        coverage: [expect.objectContaining({
          indexedUnits: 10,
          state: 'ready',
        })],
      },
    })
    engine.close()
  })

  it('keeps auxiliary indexing detached from finished media state', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-index-auxiliary-'))
    const engine = createEngine({ rootDir, initialBookName: 'index-auxiliary' })
    await engine.ready
    const created = await engine.artifacts.create('image', 'finished-image')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const targetArtifactId = created.value.artifactId
    expect((await engine.files.write(
      targetArtifactId,
      'notes.txt',
      Buffer.from('not an indexable source'),
    )).ok).toBe(true)

    let failureHandled = false
    const leases: unknown[] = []
    const context: JobHandlerContext = {
      signal: new AbortController().signal,
      setLease: (lease) => {
        leases.push(lease)
      },
      getOwnerId: () => {
        throw new Error('No artifact owner expected')
      },
      markAssetFailureHandled: () => {
        failureHandled = true
      },
    }
    const indexed = await runSemanticIndex(engine, {
      type: 'semantic_index',
      assetId: targetArtifactId,
      bookId: engine.book.get().bookId,
    }, context)

    expect(indexed).toMatchObject({
      success: true,
      semanticVisual: 'deferred',
      semanticAudio: 'deferred',
    })
    expect(failureHandled).toBe(true)
    expect(leases).toEqual([])
    const work = engine.jobs.artifactWork.read(targetArtifactId)
    expect(work.ok && work.value).toMatchObject({
      status: 'ready',
      ownerId: null,
    })
    engine.close()
  })
})

function observationsForRange(
  artifactId: string,
  objectHash: string,
  streamId: string,
  start: number,
  end: number,
) {
  return Array.from({ length: end - start }, (_, offset) => {
    const index = start + offset
    return {
      artifactId,
      objectHash,
      streamId,
      range: {
        streamId,
        objectHash,
        startTick: index * 1_000,
        durationTicks: 1_000,
        timeBase: { numerator: 1, denominator: 1_000 },
      },
      kind: 'frame' as const,
      representativeTick: index * 1_000,
      segmentationVersion: 'resume-fixture-v1',
      texts: [],
      embeddings: [{
        modality: 'visual' as const,
        embeddingSpace: 'resume-space',
        vector: [1],
        sourceHash: `${objectHash}:${index}`,
      }],
      fingerprints: [],
    }
  })
}
