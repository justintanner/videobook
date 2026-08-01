import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createEngine } from 'videobook-engine'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { markNotebookCellQueued } from '../../server/src/jobs/run-notebook.js'

describe('notebook queued execution status', () => {
  let rootDir: string
  let engine: ReturnType<typeof createEngine>

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'videobook-queued-cell-'))
    engine = createEngine({ rootDir, initialBookSlug: 'queued-cell' })
  })

  afterEach(async () => {
    engine.close()
    await rm(rootDir, { recursive: true, force: true })
  })

  it('persists the accepted run before a worker reports running', async () => {
    const created = await engine.notebooks.create('Main')
    expect(created.ok).toBe(true)
    if (!created.ok) return
    const notebook = created.value
    const cell = engine.notebooks.createCell({
      type: 'generate_image',
      slug: 'generate-image-01',
      slot: { row: 0, column: 0 },
      prompt: 'neon rain',
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
    })
    const written = await engine.notebooks.write({
      ...notebook,
      cells: [...notebook.cells, cell],
    })
    expect(written.ok).toBe(true)

    const runId = '01900000-0000-7000-8000-000000000011'
    await markNotebookCellQueued(engine, notebook.id, cell.id, runId)

    const current = engine.notebooks.read(notebook.id)
    expect(current.ok).toBe(true)
    if (!current.ok) return
    expect(current.value.execution?.[cell.id]).toMatchObject({
      runId,
      status: 'queued',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
    })
    expect(current.value.cells.find((candidate) => candidate.id === cell.id)?.inputs)
      .toMatchObject({ state: 'queued' })
  })
})
