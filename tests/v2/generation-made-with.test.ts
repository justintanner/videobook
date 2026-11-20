import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { prerender } from 'react-dom/static'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Engine, NotebookCell, NotebookDocument, RecordGenerationArgs } from 'videobook-engine'
import { closeEngineForTest, createEngineForTest } from '../../server/src/engine.js'
import { mutateNotebook } from '../../server/src/notebook-mutations.js'
import { bookUsageDef } from '../../server/src/tools/book-usage.js'
import { listCellGenerationsDef } from '../../server/src/tools/list-cell-generations.js'
import { generationRunInputs } from '../../server/src/generation-run-inputs.js'
import {
  GenerationMadeWith,
  type LoadCellGenerations,
} from '../../src/components/videobook/GenerationMadeWith'
import { GenerationTakes } from '../../src/components/videobook/GenerationTakes'
import { parseBookUsage } from '../../src/videobook/book-usage'
import {
  generationTakes,
  producerOutputsSignature,
  takeStatusText,
  takesTotal,
} from '../../src/videobook/generation-takes'
import {
  generationModelLabel,
  generationPromptSegments,
  generationRunSeconds,
  parseGenerationAttempts,
  producingGeneration,
} from '../../src/videobook/output-generation'

const WRITTEN_PROMPT = 'Open on @firstframe, then keep the red umbrella from @image1 in frame.'
const SENT_PROMPT = 'Open on the first frame, then keep the red umbrella from reference image 1 in frame.'

type Fixture = {
  notebook: NotebookDocument
  producer: NotebookCell
  output: NotebookCell
  umbrella: NotebookCell
  landing: NotebookCell
  firstArtifactId: string
  secondArtifactId: string
  orphanArtifactId: string
  umbrellaArtifactId: string
  landingArtifactId: string
}

async function createArtifact(engine: Engine, label: string, kind: 'video' | 'image' = 'video'): Promise<string> {
  const created = await engine.artifacts.create(kind, label)
  if (!created.ok) throw new Error(created.error.message)
  return created.value.artifactId
}

async function recordCompleted(
  engine: Engine,
  args: RecordGenerationArgs,
  outputArtifactId: string | null,
): Promise<void> {
  const recorded = await engine.generations.record(args)
  if (!recorded.ok) throw new Error(recorded.error.message)
  const updated = await engine.generations.update(recorded.value.generationId, outputArtifactId
    ? { status: 'completed', outputArtifactId }
    : { status: 'failed', error: 'Provider rejected the request' })
  if (!updated.ok) throw new Error(updated.error.message)
}

async function createFixture(engine: Engine): Promise<Fixture> {
  const created = await engine.notebooks.create('Boat')
  if (!created.ok) throw new Error(created.error.message)
  const notebook = created.value
  const producer = engine.notebooks.createCell({
    type: 'generate_video',
    slot: { row: 1, column: 3 },
    prompt: 'A later edit of the prompt',
    tool: 'generate_video',
    provider: 'fal',
    model: 'fal:wan-3/image-to-video',
  })
  const output = engine.notebooks.createCell({
    type: 'video',
    slot: { row: 3, column: 2 },
    inputs: { mediaRole: 'generate-video-output', producerCellId: producer.id },
  })
  const umbrellaArtifactId = await createArtifact(engine, 'red umbrella', 'image')
  const landingArtifactId = await createArtifact(engine, 'stone landing', 'image')
  const umbrella = engine.notebooks.createCell({ type: 'image', slot: { row: 2, column: 0 }, outputArtifactId: umbrellaArtifactId })
  const landing = engine.notebooks.createCell({ type: 'image', slot: { row: 2, column: 1 }, outputArtifactId: landingArtifactId })
  const edge = engine.notebooks.createEdge({ source: producer.id, target: output.id, targetInput: 'output' })
  const inputEdges = [
    engine.notebooks.createEdge({ source: landing.id, target: producer.id, targetInput: 'first_frame' }),
    engine.notebooks.createEdge({ source: umbrella.id, target: producer.id, targetInput: 'image' }),
  ]
  const written = await mutateNotebook(engine, notebook.id, 'run_notebook_cell', (current) => ({
    ...current,
    cells: [...current.cells, producer, output, umbrella, landing],
    edges: [...current.edges, edge, ...inputEdges],
  }), { cellId: producer.id })
  if (!written.ok) throw new Error(written.error.message)

  const firstArtifactId = await createArtifact(engine, 'first take')
  const secondArtifactId = await createArtifact(engine, 'second take')
  const orphanArtifactId = await createArtifact(engine, 'unrecorded take')
  const request = await engine.metadata.artifacts.write(firstArtifactId, 'generation-request', {
    type: 'generate_media',
    model: 'kie:bytedance/seedance-2-5',
    prompt: WRITTEN_PROMPT,
    refs: { first_frame: [landingArtifactId], image: [umbrellaArtifactId], video: [orphanArtifactId] },
    options: {},
  })
  if (!request.ok) throw new Error(request.error.message)
  const base = { notebookId: notebook.id, cellId: producer.id, tool: 'generate_video', provider: 'kie' }
  await recordCompleted(engine, {
    ...base,
    runId: 'run-first',
    model: 'kie:bytedance/seedance-2-5',
    prompt: WRITTEN_PROMPT,
    resolvedPrompt: SENT_PROMPT,
  }, firstArtifactId)
  await recordCompleted(engine, {
    ...base,
    runId: 'run-failed',
    model: 'kie:minimax-h3/reference-to-video',
    prompt: 'A failed attempt',
  }, null)
  await recordCompleted(engine, {
    ...base,
    runId: 'run-second',
    model: 'kie:minimax-h3/reference-to-video',
    prompt: 'A second take from the landing',
  }, secondArtifactId)
  return {
    notebook,
    producer,
    output,
    umbrella,
    landing,
    firstArtifactId,
    secondArtifactId,
    orphanArtifactId,
    umbrellaArtifactId,
    landingArtifactId,
  }
}

async function rewireProducer(engine: Engine, fixture: Fixture): Promise<NotebookDocument> {
  const written = await mutateNotebook(engine, fixture.notebook.id, 'connect_notebook_cells', (current) => ({
    ...current,
    edges: [
      ...current.edges.filter((edge) => edge.target !== fixture.producer.id),
      engine.notebooks.createEdge({ source: fixture.umbrella.id, target: fixture.producer.id, targetInput: 'first_frame' }),
    ],
  }), { cellId: fixture.producer.id })
  if (!written.ok) throw new Error(written.error.message)
  const read = engine.notebooks.read(fixture.notebook.id)
  if (!read.ok) throw new Error(read.error.message)
  return read.value
}

function realLoader(engine: Engine, notebookId: string): LoadCellGenerations {
  return async (cellId) => {
    const result = await listCellGenerationsDef(engine).handler({
      book_id: engine.book.get().bookId,
      notebook_id: notebookId,
      cell_id: cellId,
      limit: 100,
    })
    if (result.isError) throw new Error('list_cell_generations failed')
    const [content] = result.content as Array<{ type: string; text: string }>
    return parseGenerationAttempts(JSON.parse(content!.text))
  }
}

async function prerenderMarkup(element: ReturnType<typeof createElement>): Promise<string> {
  const { prelude } = await prerender(element)
  return new Response(prelude).text()
}

describe('the run behind a generated output', () => {
  let root: string
  let engine: Engine
  let fixture: Fixture

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'made-with-'))
    engine = createEngineForTest(root)
    await engine.ready
    fixture = await createFixture(engine)
  })

  afterEach(async () => {
    if (root && engine) closeEngineForTest(root, engine)
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  it('picks the completed attempt whose output is the artifact on screen', async () => {
    const attempts = await realLoader(engine, fixture.notebook.id)(fixture.output.id)

    expect(attempts).toHaveLength(3)
    const first = producingGeneration(attempts, fixture.firstArtifactId)
    expect(first).toMatchObject({
      runId: 'run-first',
      provider: 'kie',
      model: 'kie:bytedance/seedance-2-5',
      prompt: WRITTEN_PROMPT,
      resolvedPrompt: SENT_PROMPT,
    })
    expect(producingGeneration(attempts, fixture.secondArtifactId)?.runId).toBe('run-second')
    expect(producingGeneration(attempts, fixture.orphanArtifactId)).toBeNull()
    expect(generationRunSeconds(first!)).toBeGreaterThanOrEqual(0)
  })

  it('shows the provider, model and prompt of that run in the inspector card', async () => {
    const html = await prerenderMarkup(createElement(GenerationMadeWith, {
      producer: fixture.producer,
      outputCellId: fixture.output.id,
      outputArtifactId: fixture.firstArtifactId,
      bookId: engine.book.get().bookId,
      load: realLoader(engine, fixture.notebook.id),
    }))

    expect(html).toContain('aria-label="Made with"')
    expect(html).toContain('<span class="inspector-generation-from-tag">@b4</span><span>Generate video</span>')
    expect(html).toContain('<span class="inspector-made-with-provider">Kie</span>')
    expect(html).toContain('title="kie:bytedance/seedance-2-5">bytedance/seedance-2-5</strong>')
    expect(html).toContain('<code class="inspector-prompt-token">@firstframe</code>')
    expect(html).toContain('<code class="inspector-prompt-token">@image1</code>')
    expect(html).toContain('As written')
    expect(html).toContain('As sent')
    expect(html).not.toContain('A later edit of the prompt')
    expect(html).not.toContain('No recorded run')
  })

  it("falls back to the producer's current settings when no run made the artifact", async () => {
    const html = await prerenderMarkup(createElement(GenerationMadeWith, {
      producer: fixture.producer,
      outputCellId: fixture.output.id,
      outputArtifactId: fixture.orphanArtifactId,
      bookId: engine.book.get().bookId,
      load: realLoader(engine, fixture.notebook.id),
    }))

    expect(html).toContain('No recorded run for this output. Showing @b4’s current settings.')
    expect(html).toContain('<span class="inspector-made-with-provider">Fal</span>')
    expect(html).toContain('wan-3/image-to-video')
    expect(html).toContain('A later edit of the prompt')
    expect(html).not.toContain('As sent')
  })

  it('says when the run cannot be read instead of claiming none was recorded', async () => {
    const html = await prerenderMarkup(createElement(GenerationMadeWith, {
      producer: fixture.producer,
      outputCellId: fixture.output.id,
      outputArtifactId: fixture.firstArtifactId,
      bookId: engine.book.get().bookId,
      load: realLoader(engine, 'missing-notebook'),
    }))

    expect(html).toContain('Could not read the run that made this. Showing @b4’s current settings.')
    expect(html).not.toContain('No recorded run')
  })

  it('lists the media each run sent by the slot it filled and the cell that holds it', async () => {
    const attempts = await realLoader(engine, fixture.notebook.id)(fixture.output.id)

    expect(producingGeneration(attempts, fixture.firstArtifactId)?.inputs).toEqual([
      expect.objectContaining({ slot: '@firstframe', kind: 'image', artifactId: fixture.landingArtifactId, sourceCellId: fixture.landing.id }),
      expect.objectContaining({ slot: '@image1', kind: 'image', artifactId: fixture.umbrellaArtifactId, sourceCellId: fixture.umbrella.id }),
      expect.objectContaining({ slot: '@video1', kind: 'video', artifactId: fixture.orphanArtifactId, sourceCellId: null }),
    ])
    expect(producingGeneration(attempts, fixture.secondArtifactId)?.inputs).toEqual([])
  })

  it("shows the run's inputs in the card even after the producer is rewired", async () => {
    const notebook = await rewireProducer(engine, fixture)
    const html = await prerenderMarkup(createElement(GenerationMadeWith, {
      producer: fixture.producer,
      outputCellId: fixture.output.id,
      outputArtifactId: fixture.firstArtifactId,
      bookId: engine.book.get().bookId,
      load: realLoader(engine, fixture.notebook.id),
      cells: notebook.cells,
      edges: notebook.edges,
    }))

    expect(html).toContain('role="group" aria-label="Inputs"')
    expect(html).toContain('<button type="button" class="inspector-made-with-input">')
    expect(html).toContain('<span class="inspector-made-with-input-slot">@firstframe</span><span class="inspector-made-with-input-source">from @c2</span>')
    expect(html).toContain('<span class="inspector-made-with-input-slot">@image1</span><span class="inspector-made-with-input-source">from @c1</span>')
    expect(html).toContain('<span class="inspector-made-with-input-slot">@video1</span><span class="inspector-made-with-input-source">not on the grid</span>')
    expect(html).not.toContain('@firstframe</span><span class="inspector-made-with-input-source">from @c1')
  })

  it('leaves the inputs out when no recorded run made the artifact', async () => {
    const html = await prerenderMarkup(createElement(GenerationMadeWith, {
      producer: fixture.producer,
      outputCellId: fixture.output.id,
      outputArtifactId: fixture.orphanArtifactId,
      bookId: engine.book.get().bookId,
      load: realLoader(engine, fixture.notebook.id),
      cells: fixture.notebook.cells,
    }))

    expect(html).not.toContain('aria-label="Inputs"')
  })

  it('names field slots, replacement audio and earlier outputs of a cell', async () => {
    const replaced = engine.notebooks.createCell({
      type: 'image',
      slot: { row: 4, column: 0 },
      outputArtifactId: 'artifact-now',
      inputs: { outputVersionArtifactIds: ['artifact-mask', 'artifact-now'] },
    })
    const document = { ...fixture.notebook, cells: [...fixture.notebook.cells, replaced] }

    expect(generationRunInputs({
      model: 'wavespeed:openai/gpt-image-2.6-sunburst/edit',
      refs: { image: ['artifact-a', 'artifact-b'] },
      fieldRefs: { mask_image: ['artifact-mask'], unknown_field: ['artifact-x', 'artifact-y'] },
      replaceAudioWith: 'artifact-voice',
    }, document)).toEqual([
      { slot: '@image1', kind: 'image', artifactId: 'artifact-a', sourceCellId: null },
      { slot: '@image2', kind: 'image', artifactId: 'artifact-b', sourceCellId: null },
      { slot: 'Mask', kind: 'image', artifactId: 'artifact-mask', sourceCellId: replaced.id },
      { slot: 'Unknown field 1', kind: 'image', artifactId: 'artifact-x', sourceCellId: null },
      { slot: 'Unknown field 2', kind: 'image', artifactId: 'artifact-y', sourceCellId: null },
      { slot: 'Replacement audio', kind: 'audio', artifactId: 'artifact-voice', sourceCellId: null },
    ])
    expect(generationRunInputs({ model: 'retired:model', refs: { keyframe: ['k1', 'k2'], loop: ['l1'] } }, document)
      .map((input) => input.slot)).toEqual(['@loop', '@keyframe1', '@keyframe2'])
    expect(generationRunInputs(null, document)).toEqual([])
    expect(generationRunInputs({ refs: { image: [42, ''] } }, document)).toEqual([])
  })

  it('skips malformed inputs in a list_cell_generations response', () => {
    const [attempt] = parseGenerationAttempts({
      attempts: [{
        attemptId: 'g1',
        status: 'completed',
        createdAt: 1,
        inputs: [
          { slot: '@image1', kind: 'image', artifactId: 'a1', sourceCellId: 'c1', thumbnailUrl: '/t.jpg' },
          { slot: '@image2', kind: 'sticker', artifactId: 'a2' },
          { kind: 'image', artifactId: 'a3' },
          'nope',
        ],
      }],
    })

    expect(attempt?.inputs).toEqual([
      { slot: '@image1', kind: 'image', artifactId: 'a1', sourceCellId: 'c1', thumbnailUrl: '/t.jpg' },
    ])
  })

  it('says it is reading the run while the attempts load', () => {
    const html = renderToStaticMarkup(createElement(GenerationMadeWith, {
      producer: fixture.producer,
      outputCellId: fixture.output.id,
      outputArtifactId: fixture.secondArtifactId,
      bookId: engine.book.get().bookId,
      load: realLoader(engine, fixture.notebook.id),
    }))

    expect(html).toContain('Reading the run that made this…')
    expect(html).toContain('aria-busy="true"')
  })
})

type TakesFixture = {
  notebook: NotebookDocument
  producer: NotebookCell
  outputs: { d1: NotebookCell; d2: NotebookCell; d3: NotebookCell }
  currentArtifactId: string
}

async function createTakesFixture(engine: Engine): Promise<TakesFixture> {
  const created = await engine.notebooks.create('Ferry')
  if (!created.ok) throw new Error(created.error.message)
  const notebook = created.value
  const producer = engine.notebooks.createCell({
    type: 'generate_video',
    slot: { row: 1, column: 3 },
    prompt: 'Passengers step off the ferry',
    tool: 'generate_video',
    provider: 'kie',
    model: 'kie:bytedance/seedance-2-5',
  })
  const firstArtifactId = await createArtifact(engine, 'first take')
  const currentArtifactId = await createArtifact(engine, 'current take')
  const output = (column: number, outputArtifactId?: string) => engine.notebooks.createCell({
    type: 'video',
    slot: { row: 3, column },
    inputs: { mediaRole: 'generate-video-output', producerCellId: producer.id },
    ...(outputArtifactId ? { outputArtifactId } : {}),
  })
  const outputs = { d1: output(0, firstArtifactId), d2: output(1), d3: output(2, currentArtifactId) }
  const edges = Object.values(outputs).map((cell) =>
    engine.notebooks.createEdge({ source: producer.id, target: cell.id, targetInput: 'media' }))
  const written = await mutateNotebook(engine, notebook.id, 'run_notebook_cell', (current) => ({
    ...current,
    cells: [...current.cells, producer, ...Object.values(outputs)],
    edges: [...current.edges, ...edges],
  }), { cellId: producer.id })
  if (!written.ok) throw new Error(written.error.message)

  const base = { notebookId: notebook.id, cellId: producer.id, tool: 'generate_video', provider: 'kie' }
  const record = async (args: Partial<RecordGenerationArgs>, update: Parameters<Engine['generations']['update']>[1]) => {
    const recorded = await engine.generations.record({ ...base, ...args } as RecordGenerationArgs)
    if (!recorded.ok) throw new Error(recorded.error.message)
    const updated = await engine.generations.update(recorded.value.generationId, update)
    if (!updated.ok) throw new Error(updated.error.message)
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  await record({ runId: 'run-1', model: 'kie:bytedance/seedance-2-5', outputCellId: outputs.d1.id },
    { status: 'completed', outputArtifactId: firstArtifactId })
  await record({ runId: 'run-failed', model: 'kie:bytedance/seedance-2-5' },
    { status: 'failed', error: 'Provider rejected the request' })
  await record({ runId: 'run-2', model: 'kie:minimax-h3/reference-to-video', outputCellId: outputs.d2.id },
    { status: 'awaiting_provider' })
  await record({ runId: 'run-3', model: 'kie:bytedance/seedance-2-5', outputCellId: outputs.d3.id },
    { status: 'completed', outputArtifactId: currentArtifactId })

  const usage = (id: string, runId: string, entry: Partial<Parameters<Engine['usage']['record']>[0]>) => {
    const written = engine.usage.record({
      id, provider: 'kie', model: 'bytedance/seedance-2-5', activity: 'video',
      cellId: producer.id, runId, createdAt: Date.now(), ...entry,
    })
    if (!written.ok) throw new Error(written.error.message)
  }
  usage('u1', 'run-1', { status: 'completed', basis: 'reported', actualBasis: 'stated', costUsd: 2.21, estimateUsd: 2.3 })
  usage('u2', 'run-2', { model: 'minimax-h3/reference-to-video', status: 'pending', basis: 'estimated', costUsd: 1.71, estimateUsd: 1.71 })
  usage('u3', 'run-3', { status: 'completed', basis: 'reported', actualBasis: 'stated', costUsd: 12.35, estimateUsd: 12.52 })
  const read = engine.notebooks.read(notebook.id)
  if (!read.ok) throw new Error(read.error.message)
  return { notebook: read.value, producer, outputs, currentArtifactId }
}

async function producerUsage(engine: Engine, producerId: string) {
  const result = await bookUsageDef(engine).handler({
    book_id: engine.book.get().bookId,
    scope: { cell_id: producerId },
  })
  const [content] = result.content as Array<{ type: string; text: string }>
  const cell = parseBookUsage(JSON.parse(content!.text)).cell
  if (!cell) throw new Error('get_book_usage returned no cell scope')
  return cell
}

describe('every take of a producer', () => {
  let root: string
  let engine: Engine
  let fixture: TakesFixture

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'generation-takes-'))
    engine = createEngineForTest(root)
    await engine.ready
    fixture = await createTakesFixture(engine)
  })

  afterEach(async () => {
    if (root && engine) closeEngineForTest(root, engine)
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 })
  })

  async function takes() {
    const attempts = await realLoader(engine, fixture.notebook.id)(fixture.producer.id)
    const usage = await producerUsage(engine, fixture.producer.id)
    return {
      usage,
      takes: generationTakes(attempts, {
        cells: fixture.notebook.cells,
        outputCellId: fixture.outputs.d3.id,
        outputArtifactId: fixture.currentArtifactId,
        runs: usage.runs ?? [],
      }),
    }
  }

  it('lists each run newest first with its output address, model, status and cost', async () => {
    const { takes: rows, usage } = await takes()

    expect(rows.map((take) => [take.address, take.model, takeStatusText(take, 'clip'), take.cost.amount, take.current])).toEqual([
      ['@d3', 'bytedance/seedance-2-5', 'This clip · billed', '$12.35', true],
      ['@d2', 'minimax-h3/reference-to-video', 'Generating', '~$1.71', false],
      [null, 'bytedance/seedance-2-5', 'Failed', null, false],
      ['@d1', 'bytedance/seedance-2-5', 'Billed', '$2.21', false],
    ])
    expect(rows.map((take) => take.outputCellId)).toEqual([
      fixture.outputs.d3.id, fixture.outputs.d2.id, null, fixture.outputs.d1.id,
    ])
    expect(takesTotal(usage.totals)).toEqual({ billed: '$14.56', pending: '~$1.71' })
  })

  it('finds a take recorded before output cells were kept on attempts by its artifact', async () => {
    const attempts = (await realLoader(engine, fixture.notebook.id)(fixture.producer.id))
      .map((attempt) => ({ ...attempt, outputCellId: null }))
    const rows = generationTakes(attempts, {
      cells: fixture.notebook.cells,
      outputCellId: fixture.outputs.d3.id,
      outputArtifactId: fixture.currentArtifactId,
      runs: [],
    })

    expect(rows.map((take) => take.address)).toEqual(['@d3', null, null, '@d1'])
    expect(rows.map((take) => takeStatusText(take, 'clip'))).toEqual(['This clip · done', 'Generating', 'Failed', 'Done'])
  })

  it('marks the take on screen and offers every other output to select', async () => {
    const { takes: rows, usage } = await takes()
    const html = renderToStaticMarkup(createElement(GenerationTakes, {
      producer: fixture.producer,
      takes: rows,
      total: takesTotal(usage.totals),
      onSelectCell: () => undefined,
    }))

    expect(html).toContain('aria-label="Takes from @b4"')
    expect(html).toContain('4 runs')
    expect(html).toMatch(/<button type="button" class="inspector-take" aria-current="true"><span class="inspector-take-thumb inspector-take-thumb-empty" aria-hidden="true"><\/span><span class="inspector-take-address">@d3<\/span>/)
    expect(html.match(/aria-current="true"/g)).toHaveLength(1)
    expect(html).toContain('<span class="inspector-take-status inspector-take-status-running">Generating</span>')
    expect(html).toMatch(/<button type="button" class="inspector-take" disabled=""><span[^>]*><\/span><span class="inspector-take-address">Removed<\/span>/)
    expect(html.match(/<button type="button" class="inspector-take"( aria-current="true")?>/g)).toHaveLength(3)
    expect(html).toContain('<span>@b4 total</span><span><strong>$14.56</strong> billed · ~$1.71 pending</span>')
  })

  it('reads the takes with the made-with card and keeps the producer cost out of the card', async () => {
    const html = await prerenderMarkup(createElement(GenerationMadeWith, {
      producer: fixture.producer,
      outputCellId: fixture.outputs.d3.id,
      outputArtifactId: fixture.currentArtifactId,
      bookId: engine.book.get().bookId,
      load: realLoader(engine, fixture.notebook.id),
      cells: fixture.notebook.cells,
      edges: fixture.notebook.edges,
    }))

    expect(html).toContain('aria-label="Made with"')
    expect(html).toContain('aria-label="Takes from @b4"')
    expect(html).toContain('<span class="inspector-take-address">@d1</span>')
    expect(html).not.toContain('Cell cost')
  })

  it('reads the takes again when the producer gains an output or an output gets media', () => {
    const { producer, notebook, outputs } = fixture
    const before = producerOutputsSignature(producer.id, notebook.cells, notebook.edges)
    const finished = notebook.cells.map((cell) => cell.id === outputs.d2.id ? { ...cell, outputArtifactId: 'finished' } : cell)

    expect(producerOutputsSignature(producer.id, finished, notebook.edges)).not.toBe(before)
    expect(producerOutputsSignature(producer.id, [...notebook.cells].reverse(), [...notebook.edges].reverse())).toBe(before)
    expect(producerOutputsSignature('another-producer', notebook.cells, notebook.edges)).toBe('')
  })
})

describe('made-with labels', () => {
  it('drops the provider prefix the badge already shows', () => {
    expect(generationModelLabel('kie:bytedance/seedance-2-5', 'kie')).toBe('bytedance/seedance-2-5')
    expect(generationModelLabel('bytedance/seedance-2-5', 'kie')).toBe('bytedance/seedance-2-5')
    expect(generationModelLabel('fal:wan-3', 'kie')).toBe('fal:wan-3')
    expect(generationModelLabel(null, 'kie')).toBeNull()
  })

  it('splits a prompt around input slot tokens only', () => {
    expect(generationPromptSegments('Start on @firstframe with @image12, not @a1 or me@image1x.')).toEqual([
      { text: 'Start on ', token: null },
      { text: '@firstframe', token: 'firstframe' },
      { text: ' with ', token: null },
      { text: '@image12', token: 'image12' },
      { text: ', not @a1 or me@image1x.', token: null },
    ])
  })
})
