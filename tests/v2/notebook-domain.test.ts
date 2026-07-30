import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookManager } from '../../server/src/book-manager.js'
import { scopedBookEngine, withBookContext } from '../../server/src/book-context.js'
import {
  updateGenerationPlanState,
  writeGenerationPlanProvenance,
} from '../../server/src/jobs/run-notebook.js'
import { videobookDomainDefs } from '../../server/src/tools/videobook-domain.js'
import type { ToolDef } from '../../server/src/tools/tool-def.js'

function resultJson(result: Awaited<ReturnType<ToolDef['handler']>>): unknown {
  expect(result.isError, result.content[0]?.text).toBeUndefined()
  return JSON.parse(result.content[0]!.text) as unknown
}

describe('v2 notebook domain tools', () => {
  let rootDir: string
  let books: BookManager

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-v2-domain-'))
    books = new BookManager({ libraryDir: join(rootDir, 'books'), objectPrefix: 'test-objects' })
    await books.ready()
  })

  afterEach(async () => {
    await books.close()
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
  })

  it('persists a graph of real NotebookDocument cells and edges', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const createBook = byName.get('create_book')!
    const created = resultJson(await createBook.handler({ slug: 'story' })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }

    const list = resultJson(await invoke('list_notebooks', {})) as Array<{ id: string; name: string }>
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe('Main')
    const notebookId = list[0]!.id

    const prompt = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'prompt',
        slug: 'prompt-opening',
        slot: { row: 0, column: 0 },
        prompt: 'A glowing moon garden',
      },
    })) as { id: string }
    const image = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        slug: 'generate-image-opening',
        slot: { row: 0, column: 1 },
        prompt: 'A glowing moon garden',
        model: 'generate_kie_gpt_image_2_text_to_image',
      },
    })) as { id: string }

    resultJson(await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: prompt.id,
      target_cell_id: image.id,
      target_input: 'prompt',
    }))
    resultJson(await invoke('update_notebook_cell', {
      notebook_id: notebookId,
      cell_id: image.id,
      cell: { slug: 'generate-image-moon-garden', slot: { row: 1, column: 0 } },
    }))
    resultJson(await invoke('move_notebook_cells', {
      notebook_id: notebookId,
      slots: [
        { id: prompt.id, row: 1, column: 0 },
        { id: image.id, row: 0, column: 0 },
      ],
    }))

    const document = resultJson(await invoke('get_notebook', { notebook_id: notebookId })) as {
      cells: Array<{ id: string; slug: string; slot: { row: number; column: number } }>
      edges: Array<{ source: string; target: string; targetInput: string }>
    }
    expect(document.cells).toHaveLength(2)
    expect(document.cells.find((cell) => cell.id === image.id)).toMatchObject({
      slug: 'generate-image-moon-garden',
      slot: { row: 0, column: 0 },
    })
    expect(document.cells.find((cell) => cell.id === prompt.id)?.slot)
      .toEqual({ row: 1, column: 0 })
    expect('grid' in document).toBe(false)
    expect(document.edges).toEqual([{ source: prompt.id, target: image.id, targetInput: 'prompt', id: expect.any(String) }])

    resultJson(await invoke('move_notebook_cells', {
      notebook_id: notebookId,
      slots: [{ id: image.id, row: 37, column: -8 }],
    }))
    const expanded = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{ id: string; slot: { row: number; column: number } }>
    }
    expect('grid' in expanded).toBe(false)
    expect(expanded.cells.find((cell) => cell.id === image.id)?.slot)
      .toEqual({ row: 37, column: -8 })
    expect(expanded.cells.find((cell) => cell.id === prompt.id)?.slot)
      .toEqual({ row: 1, column: 0 })
  })

  it('enforces video action inputs and typed media outputs', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      slug: 'typed-actions',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }
    const notebooks = resultJson(await invoke('list_notebooks', {})) as Array<{ id: string }>
    const notebookId = notebooks[0]!.id
    const createCell = async (
      type: string,
      slug: string,
      row: number,
      column: number,
    ) => resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: { type, slug, slot: { row, column } },
    })) as { id: string; operation?: string }

    const sourceVideo = await createCell('video', 'vid-source', 0, 0)
    const sourceAudio = await createCell('audio', 'aud-source', 0, 1)
    const extractAudio = await createCell('extract_audio', 'extract-audio-source', 1, 0)
    const audioOutput = await createCell('audio', 'aud-output', 2, 0)
    const splitVideo = await createCell('split_video', 'split-video-source', 1, 1)
    const videoOutput = await createCell('video', 'vid-output', 2, 1)
    const extractFrame = await createCell('extract_frame', 'extract-frame-source', 1, 2)
    const imageOutput = await createCell('image', 'img-output', 2, 2)
    const invalidImage = await createCell('image', 'img-invalid', 3, 2)

    expect(extractAudio.operation).toBe('extract_audio')
    expect(extractFrame.operation).toBe('extract_frame')
    expect(splitVideo.operation).toBe('split_range')
    const retypedAction = await invoke('update_notebook_cell', {
      notebook_id: notebookId,
      cell_id: extractAudio.id,
      cell: { type: 'split_video' },
    })
    expect(retypedAction.isError).toBe(true)
    expect(retypedAction.content[0]?.text).toContain(
      'Cell type cannot be changed after creation',
    )

    const passiveSource = await invoke('run_notebook_cell', {
      notebook_id: notebookId,
      cell_id: sourceVideo.id,
    })
    expect(passiveSource.isError).toBe(true)
    expect(passiveSource.content[0]?.text).toContain('passive outputs')

    const invalidInput = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: sourceAudio.id,
      target_cell_id: extractAudio.id,
      target_input: 'video',
    })
    expect(invalidInput.isError).toBe(true)
    expect(invalidInput.content[0]?.text).toContain('video-producing source')

    const invalidFrameInput = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: sourceAudio.id,
      target_cell_id: extractFrame.id,
      target_input: 'video',
    })
    expect(invalidFrameInput.isError).toBe(true)
    expect(invalidFrameInput.content[0]?.text).toContain('video-producing source')

    for (const connection of [
      {
        source_cell_id: sourceVideo.id,
        target_cell_id: extractAudio.id,
        target_input: 'video',
      },
      {
        source_cell_id: extractAudio.id,
        target_cell_id: audioOutput.id,
        target_input: 'media',
      },
      {
        source_cell_id: sourceVideo.id,
        target_cell_id: splitVideo.id,
        target_input: 'video',
      },
      {
        source_cell_id: splitVideo.id,
        target_cell_id: videoOutput.id,
        target_input: 'media',
      },
      {
        source_cell_id: sourceVideo.id,
        target_cell_id: extractFrame.id,
        target_input: 'video',
      },
      {
        source_cell_id: extractFrame.id,
        target_cell_id: imageOutput.id,
        target_input: 'media',
      },
    ]) {
      resultJson(await invoke('connect_notebook_cells', {
        notebook_id: notebookId,
        ...connection,
      }))
    }

    const invalidOutput = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: extractAudio.id,
      target_cell_id: videoOutput.id,
      target_input: 'media',
    })
    expect(invalidOutput.isError).toBe(true)
    expect(invalidOutput.content[0]?.text).toContain('split video source')

    const invalidImageOutput = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: extractAudio.id,
      target_cell_id: invalidImage.id,
      target_input: 'media',
    })
    expect(invalidImageOutput.isError).toBe(true)
    expect(invalidImageOutput.content[0]?.text).toContain('extract frame source')

    const bypassedMedia = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: splitVideo.id,
      target_cell_id: extractAudio.id,
      target_input: 'video',
    })
    expect(bypassedMedia.isError).toBe(true)
    expect(bypassedMedia.content[0]?.text).toContain('video-producing source')

    const bypassedFrameMedia = await invoke('connect_notebook_cells', {
      notebook_id: notebookId,
      source_cell_id: splitVideo.id,
      target_cell_id: extractFrame.id,
      target_input: 'video',
    })
    expect(bypassedFrameMedia.isError).toBe(true)
    expect(bypassedFrameMedia.content[0]?.text).toContain('video-producing source')

    const cached = await managed.value.engine.artifacts.create('video', 'cached output')
    expect(cached.ok).toBe(true)
    if (!cached.ok) return
    resultJson(await invoke('update_notebook_cell', {
      notebook_id: notebookId,
      cell_id: videoOutput.id,
      cell: { output_artifact_id: cached.value.artifactId },
    }))
    const rejectedReplacement = await invoke('set_notebook_cell_input', {
      notebook_id: notebookId,
      target_cell_id: videoOutput.id,
      target_input: 'media',
      source_cell_id: extractAudio.id,
    })
    expect(rejectedReplacement.isError).toBe(true)

    const replacement = await createCell(
      'split_video',
      'split-video-replacement',
      3,
      1,
    )
    resultJson(await invoke('set_notebook_cell_input', {
      notebook_id: notebookId,
      target_cell_id: videoOutput.id,
      target_input: 'media',
      source_cell_id: replacement.id,
    }))
    const replaced = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{
        id: string
        inputs?: Record<string, unknown>
        output_artifact_id?: string
      }>
      edges: Array<{ source: string; target: string; targetInput: string }>
      execution?: Record<string, { stale?: boolean }>
    }
    expect(replaced.edges.filter((edge) =>
      edge.target === videoOutput.id && edge.targetInput === 'media'))
      .toEqual([expect.objectContaining({ source: replacement.id })])
    expect(replaced.cells.find((cell) => cell.id === videoOutput.id)).toMatchObject({
      inputs: { state: 'pending' },
    })
    expect(replaced.cells.find((cell) => cell.id === videoOutput.id))
      .not.toHaveProperty('output_artifact_id')
    expect(replaced.execution?.[videoOutput.id]?.stale).toBe(true)

    resultJson(await invoke('set_notebook_cell_input', {
      notebook_id: notebookId,
      target_cell_id: videoOutput.id,
      target_input: 'media',
      source_cell_id: null,
    }))
    const cleared = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as { edges: Array<{ target: string; targetInput: string }> }
    expect(cleared.edges.some((edge) =>
      edge.target === videoOutput.id && edge.targetInput === 'media')).toBe(false)

    resultJson(await invoke('delete_notebook_cell', {
      notebook_id: notebookId,
      cell_id: sourceVideo.id,
    }))
    const deleted = resultJson(await invoke('get_notebook', {
      notebook_id: notebookId,
    })) as {
      cells: Array<{ id: string }>
      edges: Array<{ source: string; target: string }>
    }
    expect(deleted.cells.some((cell) => cell.id === sourceVideo.id)).toBe(false)
    expect(deleted.edges.some((edge) =>
      edge.source === sourceVideo.id || edge.target === sourceVideo.id)).toBe(false)
  })

  it('cancels a queued persistent job explicitly', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({ slug: 'cancel-job' })) as {
      bookId: string
    }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const queued = managed.value.engine.jobs.queue.enqueue({
      type: 'semantic_index',
      payload: {
        type: 'semantic_index',
        bookId: created.bookId,
        assetId: '019f94ce-bc08-7428-8a9c-8da26066141c',
      },
      dedupeKey: 'cancel-me',
    })
    const cancelled = resultJson(await withBookContext(
      { bookId: created.bookId, engine: managed.value.engine },
      () => byName.get('cancel_job')!.handler({
        book_id: created.bookId,
        job_id: queued.job.id,
      }),
    )) as { id: number; state: string; error: { message: string } }
    expect(cancelled).toMatchObject({
      id: queued.job.id,
      state: 'aborted',
      error: { message: 'Cancelled by user' },
    })
  })

  it('adds and removes empty canonical sequence tracks', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      slug: 'track-lifecycle',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }

    const initial = resultJson(await invoke('get_primary_sequence', {})) as {
      revision: string
      tracks: Array<{ trackId: string; kind: string; name: string; ordinal: number }>
    }
    const added = resultJson(await invoke('add_sequence_track', {
      kind: 'video',
      name: 'B-roll',
    })) as typeof initial
    const addedTrack = added.tracks.find((track) => track.name === 'B-roll')
    expect(added.revision).not.toBe(initial.revision)
    expect(addedTrack).toMatchObject({
      kind: 'video',
      ordinal: initial.tracks.filter((track) => track.kind === 'video').length,
    })

    const removed = resultJson(await invoke('remove_sequence_track', {
      track_id: addedTrack!.trackId,
    })) as typeof initial
    expect(removed.revision).not.toBe(added.revision)
    expect(removed.tracks.some((track) => track.trackId === addedTrack!.trackId)).toBe(false)
    expect(removed.tracks).toHaveLength(initial.tracks.length)
  })

  it('round-trips semantic cells, typed references, and pinned search results', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({ slug: 'semantic-story' })) as {
      bookId: string
    }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const notebookId = managed.value.engine.notebooks.list()[0]!.id
    const artifact = await managed.value.engine.artifacts.create('video', 'interview')
    expect(artifact.ok).toBe(true)
    if (!artifact.ok) return
    const file = await managed.value.engine.files.write(
      artifact.value.artifactId,
      'original.mp4',
      Buffer.from('semantic video bytes'),
    )
    expect(file.ok).toBe(true)
    if (!file.ok) return
    const manifest = await managed.value.engine.files.manifest(artifact.value.artifactId)
    expect(manifest.ok).toBe(true)
    if (!manifest.ok) return
    const objectHash = manifest.value.files[0]?.objectHash
    expect(objectHash).toBeTruthy()
    if (!objectHash) return
    const stream = await managed.value.engine.streams.register({
      artifactId: artifact.value.artifactId,
      sourcePath: 'original.mp4',
      objectHash,
      streamIndex: 0,
      kind: 'video',
      timeBase: { numerator: 1, denominator: 1_000 },
      durationTicks: 12_000,
      codec: 'h264',
      video: {
        width: 1920,
        height: 1080,
        rotationDegrees: 0,
        pixelAspect: { numerator: 1, denominator: 1 },
        nominalFrameRate: { numerator: 30, denominator: 1 },
      },
    })
    expect(stream.ok, stream.ok ? '' : JSON.stringify(stream.error)).toBe(true)
    if (!stream.ok) return

    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }
    const revision = managed.value.engine.head
    const referenceId = managed.value.engine.notebooks.createCell({
      type: 'prompt',
      slug: 'prompt-reference-id',
      slot: { row: 0, column: 0 },
    }).id
    const resultId = managed.value.engine.notebooks.createCell({
      type: 'prompt',
      slug: 'prompt-result-id',
      slot: { row: 0, column: 0 },
    }).id
    const cell = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'video',
        slug: 'vid-warm-interview-moments',
        slot: { row: 0, column: 0 },
        references: [{
          id: referenceId,
          kind: 'stream',
          target_id: stream.value.streamId,
          snapshot: { objectHash },
          ordinal: 0,
        }],
        pinned_results: [{
          id: resultId,
          artifact_id: artifact.value.artifactId,
          object_hash: objectHash,
          location: {
            kind: 'timed',
            artifactId: artifact.value.artifactId,
            range: {
              streamId: stream.value.streamId,
              objectHash,
              startTick: 2_000,
              durationTicks: 3_000,
              timeBase: { numerator: 1, denominator: 1_000 },
            },
          },
          representative_tick: 3_000,
          query: { kind: 'text', text: 'warm interview' },
          signals: [{ kind: 'visual', rank: 1, score: 0.93 }],
          selected_revision: revision,
          ordinal: 0,
          created_at: 1,
        }],
      },
    })) as {
      type: string
      references: Array<{ id: string; target_id: string }>
      pinned_results: Array<{ id: string; selected_revision: string }>
    }

    expect(cell.type).toBe('video')
    expect(cell.references).toEqual([expect.objectContaining({
      id: referenceId,
      target_id: stream.value.streamId,
    })])
    expect(cell.pinned_results).toEqual([expect.objectContaining({
      id: resultId,
      selected_revision: revision,
    })])
    const stored = managed.value.engine.notebooks.read(notebookId)
    expect(stored.ok).toBe(true)
    if (!stored.ok) return
    expect(stored.value.cells[0]?.references?.[0]?.targetId).toBe(stream.value.streamId)
    expect(stored.value.cells[0]?.pinnedResults?.[0]?.artifactId).toBe(artifact.value.artifactId)
  })

  it('preserves generation plans across retry, model switch, and omit', async () => {
    const defs = videobookDomainDefs(scopedBookEngine, books)
    const byName = new Map(defs.map((def) => [def.name, def]))
    const created = resultJson(await byName.get('create_book')!.handler({
      slug: 'generation-lifecycle',
    })) as { bookId: string }
    const managed = books.get(created.bookId)
    expect(managed.ok).toBe(true)
    if (!managed.ok) return
    const notebookId = managed.value.engine.notebooks.list()[0]!.id
    const invoke = async (name: string, args: Record<string, unknown>) => {
      const def = byName.get(name)
      if (!def) throw new Error(`Missing ${name}`)
      return await withBookContext(
        { bookId: created.bookId, engine: managed.value.engine },
        () => def.handler({ book_id: created.bookId, ...args }),
      )
    }
    const image = resultJson(await invoke('create_notebook_cell', {
      notebook_id: notebookId,
      cell: {
        type: 'generate_image',
        slug: 'generate-image-opening',
        slot: { row: 0, column: 0 },
        prompt: 'A moonlit garden',
        model: 'generate_kie_gpt_image_2_text_to_image',
      },
    })) as { id: string }
    const plan = resultJson(await invoke('plan_notebook_generation', {
      notebook_id: notebookId,
      cell_id: image.id,
      source_surface: 'ui',
      actor: 'tester',
      timeline_start_frame: 12,
      duration_frames: 48,
    })) as {
      planId: string
      stages: Array<{
        kind: string
        tool: string
        provider: string
        model: string
        continuation: { destination: { timelineStartFrame: number } }
      }>
    }
    expect(plan.stages[0]).toMatchObject({
      kind: 'queued',
      tool: 'run_notebook_cell',
      provider: 'kie',
      continuation: { destination: { timelineStartFrame: 12 } },
    })
    const output = await managed.value.engine.artifacts.create('image', 'generated output')
    expect(output.ok).toBe(true)
    if (!output.ok) return
    const outputFile = await managed.value.engine.files.write(
      output.value.artifactId,
      'original.png',
      Buffer.from('generated image bytes'),
    )
    expect(outputFile.ok).toBe(true)
    if (!outputFile.ok) return
    const notebook = managed.value.engine.notebooks.read(notebookId)
    expect(notebook.ok).toBe(true)
    if (!notebook.ok) return
    const cell = notebook.value.cells.find((candidate) => candidate.id === image.id)
    expect(cell).toBeTruthy()
    if (!cell) return
    await writeGenerationPlanProvenance(
      managed.value.engine,
      {
        type: 'run_notebook',
        bookId: created.bookId,
        notebookId,
        generationPlan: plan as unknown as Record<string, unknown>,
        actor: 'tester',
        jobId: 'generation-job-1',
      },
      cell,
      output.value.artifactId,
    )
    await updateGenerationPlanState(
      managed.value.engine,
      notebookId,
      plan.planId,
      'awaiting-output',
      { outputArtifactId: output.value.artifactId },
    )
    const provenance = await managed.value.engine.metadata.artifacts.read<{
      planId: string
      provider: string
      jobId: string
      outputArtifactId: string
    }>(output.value.artifactId, 'command-plan')
    expect(provenance.ok).toBe(true)
    if (provenance.ok) {
      expect(provenance.value).toMatchObject({
        planId: plan.planId,
        provider: 'kie',
        jobId: 'generation-job-1',
        outputArtifactId: output.value.artifactId,
      })
    }
    const continuation = resultJson(await invoke('continue_notebook_generation', {
      notebook_id: notebookId,
      plan_id: plan.planId,
      actor: 'tester',
    })) as {
      parentActionId: string
      stages: Array<{ intent: { operations: Array<{ kind: string }> } }>
    }
    expect(continuation).toMatchObject({
      parentActionId: plan.planId,
      stages: [{
        intent: { operations: [expect.objectContaining({ kind: 'insert-clip' })] },
      }],
    })
    const retry = resultJson(await invoke('revise_notebook_generation_plan', {
      notebook_id: notebookId,
      plan_id: plan.planId,
      action: 'retry',
      source_surface: 'slash',
      actor: 'tester',
    })) as { planId: string; parentActionId: string }
    expect(retry.planId).not.toBe(plan.planId)
    expect(retry.parentActionId).toBe(plan.planId)
    const switched = resultJson(await invoke('revise_notebook_generation_plan', {
      notebook_id: notebookId,
      plan_id: retry.planId,
      action: 'switch',
      model: 'generate_kie_wan_2_7_text_to_image',
      source_surface: 'chat',
      actor: 'tester',
    })) as {
      planId: string
      stages: Array<{ model: string; input: { generation_tool: string } }>
    }
    expect(switched.stages[0]).toMatchObject({
      model: 'Wan27ImageRequestSchema',
      input: { generation_tool: 'generate_kie_wan_2_7_text_to_image' },
    })
    resultJson(await invoke('revise_notebook_generation_plan', {
      notebook_id: notebookId,
      plan_id: switched.planId,
      action: 'omit',
      source_surface: 'ui',
      actor: 'tester',
    }))
    const plans = resultJson(await invoke('list_notebook_generation_plans', {
      notebook_id: notebookId,
    })) as Array<{ planId: string; status: string }>
    expect(plans).toEqual(expect.arrayContaining([
      expect.objectContaining({
        planId: plan.planId,
        status: 'continued',
        outputArtifactId: output.value.artifactId,
      }),
      expect.objectContaining({ planId: retry.planId, status: 'planned' }),
      expect.objectContaining({ planId: switched.planId, status: 'omitted' }),
    ]))
  })
})
