import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  createEngine,
  type IndexManifest,
  type SearchHit,
  type TemporalSearchProvider,
} from 'videobook-engine'
import { commandPlanDefs } from '../../server/src/tools/command-plan.js'
import { semanticSearchDefs } from '../../server/src/tools/semantic-search.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'
import { searchReferenceStore } from '../../server/src/search-reference-store.js'

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

const manifest: IndexManifest = {
  manifestId: 'search-tool-fixture',
  provider: 'fixture',
  modelId: 'fixture',
  modelRevision: '1',
  license: 'test',
  embeddingSpace: 'fixture-space',
  dimensions: 3,
  modalities: ['visual', 'audio', 'metadata'],
  supportedLanguages: ['en'],
  preprocessingVersion: '1',
  extractorVersion: '1',
  createdAt: 1,
}

class Provider implements TemporalSearchProvider {
  readonly manifestId = manifest.manifestId

  async prepare(): Promise<void> {}

  async embedText(): Promise<Float32Array> {
    return Float32Array.from([1, 0, 0])
  }
}

describe('semantic search MCP tools', () => {
  let rootDir: string | undefined

  afterEach(async () => {
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  it('returns bounded moments, reasons, coverage, and index status', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-search-tools-'))
    const engine = createEngine({ rootDir, initialBookName: 'search-tools' })
    await engine.ready
    const artifact = await engine.artifacts.create('video', 'golden-hour-van')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    const written = await engine.files.write(
      artifact.value.artifactId,
      'original.mp4',
      Buffer.from('video'),
    )
    expect(written.ok).toBe(true)
    const fileManifest = await engine.files.manifest(artifact.value.artifactId)
    expect(fileManifest.ok).toBe(true)
    if (!fileManifest.ok) return
    const objectHash = fileManifest.value.files[0]?.objectHash
    expect(objectHash).toBeTruthy()
    if (!objectHash) return
    const stream = await engine.streams.register({
      artifactId: artifact.value.artifactId,
      sourcePath: 'original.mp4',
      objectHash,
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
    expect(engine.temporalSearch.manifests.register(manifest).ok).toBe(true)
    engine.temporalSearch.providers.register(new Provider())
    expect(engine.temporalSearch.commitBatch({
      artifactId: artifact.value.artifactId,
      objectHash,
      manifestId: manifest.manifestId,
      generation: 'fixture-generation',
      phase: 'visual',
      maxUnits: 1,
      observations: [{
        artifactId: artifact.value.artifactId,
        objectHash,
        streamId: stream.value.streamId,
        range: {
          streamId: stream.value.streamId,
          objectHash,
          startTick: 2_000,
          durationTicks: 3_000,
          timeBase: { numerator: 1, denominator: 1_000 },
        },
        kind: 'shot',
        representativeTick: 3_500,
        segmentationVersion: '1',
        texts: [{
          kind: 'description',
          language: 'en',
          text: 'A red delivery van crosses a sunlit yard',
        }],
        embeddings: [{
          modality: 'visual',
          embeddingSpace: manifest.embeddingSpace,
          vector: [1, 0, 0],
          sourceHash: `${objectHash}:2000`,
        }],
        fingerprints: [],
      }],
      coveredRanges: [{
        streamId: stream.value.streamId,
        objectHash,
        startTick: 2_000,
        durationTicks: 3_000,
        timeBase: { numerator: 1, denominator: 1_000 },
      }],
      totalUnits: 1,
      complete: true,
    }).ok).toBe(true)
    expect(engine.temporalSearch.activate(
      manifest.manifestId,
      'fixture-generation',
    ).ok).toBe(true)

    const tools = new Map(semanticSearchDefs(engine).map((tool) => [tool.name, tool]))
    const search = resultJson(await tools.get('search_moments')!.handler({
      book_id: engine.book.get().bookId,
      query: { text: 'red van', limit: 5 },
    })) as {
      hits: SearchHit[]
      coverage: { state: string }
    }
    expect(search.hits).toHaveLength(1)
    expect(search.hits[0]).toMatchObject({
      excerpt: 'A red delivery van crosses a sunlit yard',
      signals: expect.arrayContaining([expect.objectContaining({ kind: 'visual' })]),
    })
    expect(search.coverage.state).toBe('ready')
    const reference = searchReferenceStore.put({
      kind: 'image',
      name: 'portable-reference.png',
      reference: {
        kind: 'image',
        embeddingSpace: manifest.embeddingSpace,
        vector: [1, 0, 0],
      },
    })
    const reverse = resultJson(await tools.get('search_moments')!.handler({
      book_id: engine.book.get().bookId,
      query: { artifactKinds: ['video'], limit: 5 },
      reference_id: reference.reference_id,
    })) as { hits: SearchHit[] }
    expect(reverse.hits[0]?.artifactId).toBe(artifact.value.artifactId)
    searchReferenceStore.release(reference.reference_id)
    const status = resultJson(await tools.get('get_search_index_status')!.handler({
      book_id: engine.book.get().bookId,
    })) as { manifests: IndexManifest[]; providers: string[]; stats: { segments: number } }
    expect(status.manifests).toEqual([manifest])
    expect(status.providers).toEqual(expect.arrayContaining([manifest.manifestId]))
    expect(status.stats.segments).toBe(1)
    const ingest = resultJson(await tools.get('list_ingest_status')!.handler({
      book_id: engine.book.get().bookId,
    })) as Array<{ state: string; missingOutputs: string[] }>
    expect(ingest).toEqual([
      expect.objectContaining({
        state: 'partial',
        missingOutputs: expect.arrayContaining(['ocr']),
      }),
    ])
    const notebook = await engine.notebooks.create('Search selects')
    expect(notebook.ok).toBe(true)
    if (!notebook.ok) return
    const coverage = resultJson(
      await tools.get('suggest_sequence_coverage')!.handler({
        book_id: engine.book.get().bookId,
        text: 'red van at golden hour',
        timeline_start_frame: 180,
        duration_frames: 45,
      }),
    ) as {
      existingFirst: boolean
      hits: SearchHit[]
      generationFallback: { offered: boolean }
    }
    expect(coverage).toMatchObject({
      existingFirst: true,
      generationFallback: { offered: false },
    })
    expect(coverage.hits[0]?.artifactId).toBe(artifact.value.artifactId)
    const roughCut = resultJson(
      await tools.get('plan_notebook_rough_cut')!.handler({
        book_id: engine.book.get().bookId,
        notebook_id: notebook.value.id,
        source_surface: 'ui',
        actor: 'rough-cut-fixture',
        max_repeats_per_artifact: 1,
        min_shot_frames: 30,
        max_shot_frames: 60,
        beats: [{
          beat_id: 'arrival',
          text: 'red van arrives',
          timeline_start_frame: 180,
          duration_frames: 45,
        }, {
          beat_id: 'departure',
          text: 'red van leaves',
          timeline_start_frame: 225,
          duration_frames: 45,
        }],
      }),
    ) as {
      confirmation: { required: boolean }
      suggestions: Array<{
        suggestionId: string
        label: string
        beatId: string
        included: boolean
        hit: SearchHit
        operation: { kind: string }
      }>
      uncoveredBeats: Array<{ beatId: string }>
      generationFallback: { offered: boolean }
      stages: Array<{ intent: unknown }>
    }
    expect(roughCut).toMatchObject({
      confirmation: { required: true },
      suggestions: [{
        suggestionId: 'arrival',
        label: 'red van arrives',
        beatId: 'arrival',
        included: true,
        operation: { kind: 'insert-clip' },
        hit: expect.objectContaining({
          artifactId: artifact.value.artifactId,
        }),
      }],
      uncoveredBeats: [{ beatId: 'departure' }],
      generationFallback: { offered: true },
    })
    const editTools = new Map(
      commandPlanDefs(engine).map((tool) => [tool.name, tool]),
    )
    const roughPreview = resultJson(
      await editTools.get('preview_edit_intent')!.handler({
        book_id: engine.book.get().bookId,
        intent: roughCut.stages[0]!.intent,
      }),
    ) as { valid: boolean }
    expect(roughPreview.valid).toBe(true)
    const soundArtifact = await engine.artifacts.create('audio', 'engine-whoosh')
    expect(soundArtifact.ok).toBe(true)
    if (!soundArtifact.ok) return
    expect((await engine.files.write(
      soundArtifact.value.artifactId,
      'original.wav',
      Buffer.from('audio'),
    )).ok).toBe(true)
    const soundFiles = await engine.files.manifest(soundArtifact.value.artifactId)
    expect(soundFiles.ok).toBe(true)
    if (!soundFiles.ok) return
    const soundHash = soundFiles.value.files[0]?.objectHash
    expect(soundHash).toBeTruthy()
    if (!soundHash) return
    const soundStream = await engine.streams.register({
      artifactId: soundArtifact.value.artifactId,
      sourcePath: 'original.wav',
      objectHash: soundHash,
      streamIndex: 0,
      kind: 'audio',
      timeBase: { numerator: 1, denominator: 48_000 },
      durationTicks: 48_000,
      codec: 'pcm_s16le',
      audio: {
        sampleRateHz: 48_000,
        channels: 1,
        channelLayout: 'mono',
      },
    })
    expect(soundStream.ok).toBe(true)
    if (!soundStream.ok) return
    expect(engine.temporalSearch.commitBatch({
      artifactId: soundArtifact.value.artifactId,
      objectHash: soundHash,
      manifestId: manifest.manifestId,
      generation: 'fixture-generation',
      phase: 'audio',
      maxUnits: 1,
      observations: [{
        artifactId: soundArtifact.value.artifactId,
        objectHash: soundHash,
        streamId: soundStream.value.streamId,
        range: {
          streamId: soundStream.value.streamId,
          objectHash: soundHash,
          startTick: 0,
          durationTicks: 48_000,
          timeBase: soundStream.value.timeBase,
        },
        kind: 'audio-event',
        representativeTick: 24_000,
        segmentationVersion: '1',
        texts: [{
          kind: 'description',
          language: 'en',
          text: 'A cinematic engine whoosh',
        }],
        embeddings: [{
          modality: 'audio',
          embeddingSpace: manifest.embeddingSpace,
          vector: [1, 0, 0],
          sourceHash: `${soundHash}:0`,
        }],
        fingerprints: [],
      }],
      coveredRanges: [{
        streamId: soundStream.value.streamId,
        objectHash: soundHash,
        startTick: 0,
        durationTicks: 48_000,
        timeBase: soundStream.value.timeBase,
      }],
      totalUnits: 1,
      complete: true,
    }).ok).toBe(true)
    const soundPlan = resultJson(
      await tools.get('plan_sequence_sound_effects')!.handler({
        book_id: engine.book.get().bookId,
        source_surface: 'ui',
        actor: 'sound-fixture',
        moments: [{
          beat_id: 'engine-start',
          text: 'engine whoosh',
          timeline_start_frame: 240,
          duration_frames: 30,
        }],
      }),
    ) as {
      suggestions: Array<{
        category: string
        included: boolean
        operation: { kind: string; placement: { trackId: string } }
      }>
      stages: Array<{ intent: unknown }>
    }
    expect(soundPlan.suggestions).toEqual([
      expect.objectContaining({
        category: 'sound-effect',
        included: true,
        operation: expect.objectContaining({ kind: 'insert-clip' }),
      }),
    ])
    const soundPreview = resultJson(
      await editTools.get('preview_edit_intent')!.handler({
        book_id: engine.book.get().bookId,
        intent: soundPlan.stages[0]!.intent,
      }),
    ) as { valid: boolean }
    expect(soundPreview.valid).toBe(true)
    const pinned = resultJson(await tools.get('pin_search_moment')!.handler({
      book_id: engine.book.get().bookId,
      notebook_id: notebook.value.id,
      cell_label: 'Red van selects',
      query: { text: 'red van' },
      hit: search.hits[0],
    })) as { cell: { type: string; pinnedResults: SearchHit[] } }
    expect(pinned.cell.type).toBe('video')
    expect(pinned.cell.pinnedResults).toHaveLength(1)
    const sent = resultJson(await tools.get('send_search_moment_to_sequence')!.handler({
      book_id: engine.book.get().bookId,
      hit: search.hits[0],
    })) as { commit: { sequence: { clips: Array<{ source: { artifactId: string } }> } } }
    expect(sent.commit.sequence.clips).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({ artifactId: artifact.value.artifactId }),
      }),
    ])
    const targets = resultJson(
      await tools.get('list_sequence_replace_targets')!.handler({
        book_id: engine.book.get().bookId,
      }),
    ) as {
      targets: Array<{ clipId: string; timelineStartFrame: number }>
    }
    expect(targets.targets).toHaveLength(1)
    const replaceTarget = targets.targets.find((target) =>
      target.timelineStartFrame === 0)
    expect(replaceTarget).toBeTruthy()
    if (!replaceTarget) return
    const replacementHit: SearchHit = {
      ...search.hits[0]!,
      location: {
        kind: 'timed',
        artifactId: artifact.value.artifactId,
        range: {
          streamId: stream.value.streamId,
          objectHash,
          startTick: 5_000,
          durationTicks: 2_000,
          timeBase: stream.value.timeBase,
        },
      },
      representativeTick: 6_000,
    }
    const replacementPreview = resultJson(
      await tools.get('replace_sequence_clip_with_search_moment')!.handler({
        book_id: engine.book.get().bookId,
        hit: replacementHit,
        clip_id: replaceTarget.clipId,
      }),
    ) as {
      confirmationRequired: boolean
      commandId: string
      baseRevision: string
      preview: { valid: boolean; previewHash: string }
    }
    expect(replacementPreview).toMatchObject({
      confirmationRequired: true,
      preview: { valid: true },
    })
    expect(engine.sequences.getPrimary().clips[0]?.source).toMatchObject({
      kind: 'timed',
      range: { startTick: 2_000 },
    })
    const replacement = resultJson(
      await tools.get('replace_sequence_clip_with_search_moment')!.handler({
        book_id: engine.book.get().bookId,
        hit: replacementHit,
        clip_id: replaceTarget.clipId,
        command_id: replacementPreview.commandId,
        base_revision: replacementPreview.baseRevision,
        preview_hash: replacementPreview.preview.previewHash,
      }),
    ) as {
      commit: {
        sequence: {
          clips: Array<{ source: { kind: string; range: { startTick: number } } }>
        }
      }
    }
    expect(replacement.commit.sequence.clips).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: expect.objectContaining({
          kind: 'timed',
          range: expect.objectContaining({ startTick: 5_000 }),
        }),
      }),
    ]))
    engine.close()
  })
})
