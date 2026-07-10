import { describe, expect, it } from 'vitest'
import { deriveStepEstimateCall } from './useCanvasCostEstimates'
import type { FullPreviewResponse, JSONSchema, ModelOption } from '@/components/gen/types'
import type { NotebookPlanDefinition, NotebookPlanStep } from './types'

const emptySchema: JSONSchema = { type: 'object', properties: {} }

function option(overrides: Partial<ModelOption> & Pick<ModelOption, 'key' | 'tool_name'>): ModelOption {
  return {
    label: overrides.key,
    description: '',
    schema: emptySchema,
    prefilled_values: {},
    validation: { valid: true, missing_required: [], warnings: [] },
    ...overrides,
  }
}

function preview(selectedModel: string, options: ModelOption[]): FullPreviewResponse {
  return {
    category: 'image',
    selected_model: selectedModel,
    model_options: options,
    tool_name: options[0]?.tool_name ?? '',
    tool_description: '',
    schema: emptySchema,
    prefilled_values: {},
    validation: { valid: true, missing_required: [], warnings: [] },
  }
}

function step(overrides: Partial<NotebookPlanStep> & Pick<NotebookPlanStep, 'id' | 'type'>): NotebookPlanStep {
  return {
    componentType: 'task',
    name: overrides.id,
    properties: {},
    ...overrides,
  }
}

function definition(...sequence: NotebookPlanStep[]): NotebookPlanDefinition {
  return { properties: {}, sequence }
}

describe('deriveStepEstimateCall', () => {
  it('returns null for prompt steps and when there is no preview', () => {
    const promptStep = step({ id: 'p1', type: 'prompt', properties: { text: 'hi' } })
    expect(deriveStepEstimateCall(definition(promptStep), promptStep, preview('nano', [option({ key: 'nano', tool_name: 't' })]), 'proj')).toBeNull()
    const image = step({ id: 'i1', type: 'image' })
    expect(deriveStepEstimateCall(definition(image), image, null, 'proj')).toBeNull()
  })

  it('returns null when the step model is not in the catalog', () => {
    const imageStep = step({ id: 'i1', type: 'image', properties: { model: 'ghost', values: {} } })
    expect(deriveStepEstimateCall(definition(imageStep), imageStep, preview('nano', [option({ key: 'nano', tool_name: 't' })]), 'proj')).toBeNull()
  })

  it('merges prefilled_values under step values and appends project_slug', () => {
    const opt = option({ key: 'nano', tool_name: 'generate_nano', prefilled_values: { aspect_ratio: '1:1', quality: 'high' } })
    const imageStep = step({ id: 'i1', type: 'image', properties: { model: 'nano', values: { aspect_ratio: '16:9' } } })
    const derived = deriveStepEstimateCall(definition(imageStep), imageStep, preview('nano', [opt]), 'proj-a')
    expect(derived?.toolName).toBe('generate_nano')
    expect(derived?.input).toEqual({ aspect_ratio: '16:9', quality: 'high', project_slug: 'proj-a' })
    expect(derived?.stepId).toBe('i1')
  })

  it('falls back to the category default model when the step has no model', () => {
    const opt = option({ key: 'default-model', tool_name: 'generate_default' })
    const imageStep = step({ id: 'i1', type: 'image', properties: { model: '', values: {} } })
    const derived = deriveStepEstimateCall(definition(imageStep), imageStep, preview('default-model', [opt]), 'proj')
    expect(derived?.toolName).toBe('generate_default')
  })

  it('resolves the mode-specific tool name for moded options', () => {
    const opt = option({
      key: 'omni',
      tool_name: 'generate_omni_t2v',
      schema: { type: 'object', properties: { image_slugs: { type: 'array' } } },
      modes: {
        shared_params: ['prompt'],
        default_mode: 't2v',
        modes: [
          { key: 't2v', label: 'Text', params: [] },
          {
            key: 'i2v',
            label: 'Image',
            params: ['image_slugs'],
            tool_name: 'generate_omni_i2v',
            asset_slots: [{ param: 'image_slugs', kind: 'image', label: 'Images', max: 1 }],
          },
        ],
      },
    })
    const t2v = step({ id: 'v1', type: 'video', properties: { model: 'omni', values: {} } })
    const asset = step({ id: 'asset', type: 'asset', properties: { slug: '@img-a' } })
    const i2v = step({ id: 'v2', type: 'video', properties: { model: 'omni', values: {}, inputs: ['asset'] } })
    expect(deriveStepEstimateCall(definition(t2v), t2v, preview('omni', [opt]), 'proj')?.toolName).toBe('generate_omni_t2v')
    expect(deriveStepEstimateCall(definition(asset, i2v), i2v, preview('omni', [opt]), 'proj')?.toolName).toBe('generate_omni_i2v')
  })

  it('produces the same key for identical calls and differing keys otherwise', () => {
    const opt = option({ key: 'nano', tool_name: 'generate_nano' })
    const first = step({ id: 'i1', type: 'image', properties: { model: 'nano', values: { seed: 1 } } })
    const second = step({ id: 'i2', type: 'image', properties: { model: 'nano', values: { seed: 1 } } })
    const third = step({ id: 'i3', type: 'image', properties: { model: 'nano', values: { seed: 2 } } })
    const a = deriveStepEstimateCall(definition(first), first, preview('nano', [opt]), 'proj')
    const b = deriveStepEstimateCall(definition(second), second, preview('nano', [opt]), 'proj')
    const c = deriveStepEstimateCall(definition(third), third, preview('nano', [opt]), 'proj')
    expect(a?.key).toBe(b?.key)
    expect(a?.key).not.toBe(c?.key)
  })

  it('uses a connected image as a first frame when estimating a moded video step', () => {
    const opt = option({
      key: 'omni',
      tool_name: 'generate_omni_t2v',
      schema: { type: 'object', properties: { first_frame_slug: { type: 'string' } } },
      modes: {
        shared_params: ['prompt'],
        default_mode: 't2v',
        modes: [
          { key: 't2v', label: 'Text', params: [] },
          {
            key: 'i2v',
            label: 'Image',
            params: ['first_frame_slug'],
            tool_name: 'generate_omni_i2v',
            asset_slots: [{ param: 'first_frame_slug', kind: 'image', label: 'First frame', max: 1 }],
          },
        ],
      },
    })
    const source = step({ id: 'image-1', type: 'image', properties: { asset_ids: ['img-frame'] } })
    const target = step({
      id: 'video-1',
      type: 'video',
      properties: { model: 'omni', values: {}, inputs: ['image-1'], first_frame_source: 'image-1' },
    })
    expect(deriveStepEstimateCall(definition(source, target), target, preview('omni', [opt]), 'proj')?.toolName)
      .toBe('generate_omni_i2v')
  })
})
