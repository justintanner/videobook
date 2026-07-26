import { describe, expect, it } from 'vitest'
import type { ModelOption } from '@/components/gen/types'
import { appendRunAsset, stepRunStatus } from './model'
import type { NotebookPlanDefinition, NotebookPlanStep } from './types'
import { submitNotebookGeneration } from './useNotebookRun'

const option: ModelOption = {
  key: 'nano_banana',
  label: 'Nano',
  tool_name: 'generate_image',
  description: '',
  prefilled_values: {},
  validation: { valid: true, missing_required: [], warnings: [] },
  schema: {
    type: 'object',
    properties: {
      prompt: { type: 'string' },
    },
  },
}

const step: NotebookPlanStep = {
  id: 'image-1',
  componentType: 'task',
  type: 'generate_image',
  name: 'Image',
  properties: {
    media_type: 'image',
    model: 'nano_banana',
    provider: 'google',
    values: { prompt: 'a fox' },
    asset_ids: [],
  },
}

describe('submitNotebookGeneration lifecycle', () => {
  it('returns after enqueue with asset id and appends asset_ids without waiting for ready', async () => {
    let resolveTool!: (value: {
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }) => void
    const toolPromise = new Promise<{
      content: Array<{ type: string; text: string }>
      isError?: boolean
    }>((resolve) => {
      resolveTool = resolve
    })

    let callToolSeen = false
    let duringCallTool: 'pending' | 'done' | null = null
    const callTool = async (name: string, args: Record<string, unknown>) => {
      callToolSeen = true
      expect(name).toBe('generate_image')
      expect(args.book_id).toBe('demo')
      expect(args.prompt).toBe('a fox')
      duringCallTool = 'pending'
      const result = await toolPromise
      duringCallTool = 'done'
      return result
    }

    let definition: NotebookPlanDefinition = {
      properties: {},
      sequence: [step],
    }
    const replaceDefinition = async (next: NotebookPlanDefinition) => {
      definition = next
    }

    const lifecycle: string[] = []
    const submitPromise = submitNotebookGeneration({
      step,
      option,
      provider: 'google',
      values: { prompt: 'a fox' },
      bookId: 'demo',
      callTool: callTool as never,
      getDefinition: () => definition,
      replaceDefinition,
      onGenerationLifecycle: (event) => {
        lifecycle.push(event.phase)
      },
    })

    expect(callToolSeen).toBe(true)
    expect(duringCallTool).toBe('pending')
    // Enqueue resolves with asset id while the media item is still generating.
    resolveTool({
      content: [{ type: 'text', text: JSON.stringify({ img_asset_id: 'img-enqueued-1', status: 'enqueued' }) }],
    })
    const result = await submitPromise
    expect(duringCallTool).toBe('done')
    expect(result).toEqual({ ok: true, assetId: 'img-enqueued-1', requestId: expect.any(String) })
    expect(lifecycle).toEqual(['started', 'submitted'])
    expect(definition.sequence[0].properties.asset_ids).toEqual(['img-enqueued-1'])

    // Asset still pending is orthogonal to submit completion — re-run path can append again.
    expect(stepRunStatus(definition.sequence[0], [
      { id: 'img-enqueued-1', status: 'generating' },
    ]).state).toBe('pending')
    const second = appendRunAsset(definition, 'image-1', 'img-second')
    expect(second.sequence[0].properties.asset_ids).toEqual(['img-enqueued-1', 'img-second'])
  })

  it('surfaces tool errors without mutating asset_ids', async () => {
    const definition: NotebookPlanDefinition = {
      properties: {},
      sequence: [step],
    }
    const result = await submitNotebookGeneration({
      step,
      option,
      provider: 'google',
      values: { prompt: 'x' },
      bookId: 'demo',
      callTool: (async () => ({
        isError: true,
        content: [{ type: 'text', text: 'quota exceeded' }],
      })) as never,
      getDefinition: () => definition,
      replaceDefinition: async () => {},
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.message).toBe('quota exceeded')
    expect(definition.sequence[0].properties.asset_ids).toEqual([])
  })
})
