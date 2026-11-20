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
import { listCellGenerationsDef } from '../../server/src/tools/list-cell-generations.js'
import {
  GenerationMadeWith,
  type LoadCellGenerations,
} from '../../src/components/videobook/GenerationMadeWith'
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
  firstArtifactId: string
  secondArtifactId: string
  orphanArtifactId: string
}

async function createArtifact(engine: Engine, label: string): Promise<string> {
  const created = await engine.artifacts.create('video', label)
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
  const edge = engine.notebooks.createEdge({ source: producer.id, target: output.id, targetInput: 'output' })
  const written = await mutateNotebook(engine, notebook.id, 'run_notebook_cell', (current) => ({
    ...current,
    cells: [...current.cells, producer, output],
    edges: [...current.edges, edge],
  }), { cellId: producer.id })
  if (!written.ok) throw new Error(written.error.message)

  const firstArtifactId = await createArtifact(engine, 'first take')
  const secondArtifactId = await createArtifact(engine, 'second take')
  const orphanArtifactId = await createArtifact(engine, 'unrecorded take')
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
  return { notebook, producer, output, firstArtifactId, secondArtifactId, orphanArtifactId }
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
