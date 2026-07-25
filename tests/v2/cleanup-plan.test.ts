import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { commandPlanDefs } from '../../server/src/tools/command-plan.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'

describe('notebook cleanup plan', () => {
  let rootDir: string | undefined
  let books: BookManager | undefined

  afterEach(async () => {
    await books?.close()
    if (rootDir) await rm(rootDir, { recursive: true, force: true })
  })

  it('keeps filler, silence, and weak-section findings selectable and previewable', async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-cleanup-plan-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books') })
    await books.ready()
    const created = await books.create('cleanup-plan')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const managed = books.get(created.value.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const engine = managed.value.engine
    const notebook = engine.notebooks.list()[0]
    expect(notebook).toBeTruthy()
    if (!notebook) return
    const artifact = await engine.artifacts.create('audio', 'narration')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    expect((await engine.files.write(
      artifact.value.artifactId,
      'original.wav',
      Buffer.from('fixture-audio'),
    )).ok).toBe(true)
    const files = await engine.files.manifest(artifact.value.artifactId)
    expect(files.ok).toBe(true)
    if (!files.ok) return
    const objectHash = files.value.files[0]?.objectHash
    expect(objectHash).toBeTruthy()
    if (!objectHash) return
    const timeBase = { numerator: 1, denominator: 1_000 }
    const stream = await engine.streams.register({
      artifactId: artifact.value.artifactId,
      sourcePath: 'original.wav',
      objectHash,
      streamIndex: 0,
      kind: 'audio',
      timeBase,
      durationTicks: 5_000,
      codec: 'pcm_s16le',
      audio: {
        sampleRateHz: 48_000,
        channels: 1,
        channelLayout: 'mono',
      },
    })
    expect(stream.ok).toBe(true)
    if (!stream.ok) return
    const transcript = await engine.transcripts.import({
      artifactId: artifact.value.artifactId,
      streamId: stream.value.streamId,
      objectHash,
      language: 'en',
      provider: 'fixture',
      segments: [{
        ordinal: 0,
        range: {
          streamId: stream.value.streamId,
          objectHash,
          startTick: 0,
          durationTicks: 1_800,
          timeBase,
        },
        text: 'um start again',
        kind: 'speech',
        words: [{
          ordinal: 0,
          startTick: 0,
          durationTicks: 200,
          text: 'um',
          confidence: 0.98,
          corrected: false,
        }, {
          ordinal: 1,
          startTick: 200,
          durationTicks: 200,
          text: 'start',
          confidence: 0.98,
          corrected: false,
        }, {
          ordinal: 2,
          startTick: 1_400,
          durationTicks: 400,
          text: 'again',
          confidence: 0.98,
          corrected: false,
        }],
      }, {
        ordinal: 1,
        range: {
          streamId: stream.value.streamId,
          objectHash,
          startTick: 2_500,
          durationTicks: 1_000,
          timeBase,
        },
        text: 'unclear ending',
        confidence: 0.4,
        kind: 'speech',
        words: [{
          ordinal: 0,
          startTick: 2_500,
          durationTicks: 400,
          text: 'unclear',
          confidence: 0.4,
          corrected: false,
        }, {
          ordinal: 1,
          startTick: 2_900,
          durationTicks: 400,
          text: 'ending',
          confidence: 0.4,
          corrected: false,
        }],
      }],
    })
    expect(transcript.ok).toBe(true)
    const tools = new Map(
      videobookDomainDefs(engine, books).map((tool) => [tool.name, tool]),
    )
    const setSpine = await tools.get('set_notebook_audio_spine')!.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      artifact_id: artifact.value.artifactId,
    })
    expect(setSpine.isError, setSpine.content[0]?.text).toBeUndefined()
    const planned = await tools.get('plan_notebook_cleanup')!.handler({
      book_id: created.value.bookId,
      notebook_id: notebook.id,
      source_surface: 'ui',
      actor: 'cleanup-fixture',
    })
    expect(planned.isError, planned.content[0]?.text).toBeUndefined()
    const plan = JSON.parse(planned.content[0]!.text) as {
      suggestions: Array<{ category: string; included: boolean }>
      stages: Array<{ intent: unknown }>
    }
    expect(plan.suggestions.map((suggestion) => suggestion.category)).toEqual([
      'filler',
      'silence',
      'weak-section',
    ])
    expect(plan.suggestions.every((suggestion) => suggestion.included)).toBe(true)
    const editTools = new Map(
      commandPlanDefs(engine).map((tool) => [tool.name, tool]),
    )
    const preview = await editTools.get('preview_edit_intent')!.handler({
      book_id: created.value.bookId,
      intent: plan.stages[0]!.intent,
    })
    expect(preview.isError, preview.content[0]?.text).toBeUndefined()
    expect(JSON.parse(preview.content[0]!.text)).toMatchObject({ valid: true })
  })
})
