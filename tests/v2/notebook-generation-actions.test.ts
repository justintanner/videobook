import { describe, expect, it } from 'vitest'
import type { NotebookCell } from 'videobook-engine'
import {
  asNotebookGenerationActions,
  changeGenerationSelection,
  generationActionFieldOptions,
  initialGenerationSelection,
  type NotebookGenerationAction,
} from '../../src/videobook/notebook-generation-actions'

const actions: NotebookGenerationAction[] = [
  {
    cellTypes: ['generate_image'],
    provider: 'kie',
    model: 'GptImage2TextToImageRequestSchema',
    operation: 'text_to_image',
    tool: 'generate_kie_gpt_image_2_text_to_image',
    title: 'GPT Image 2',
    isDefault: true,
  },
  {
    cellTypes: ['generate_image'],
    provider: 'kie',
    model: 'NanoBananaProRequestSchema',
    operation: 'text_to_image',
    tool: 'generate_kie_nano_banana_pro_text_to_image',
    title: 'Nano Banana Pro',
    isDefault: false,
  },
  {
    cellTypes: ['generate_image'],
    provider: 'xai',
    model: 'XaiImageGenerateRequestSchema',
    operation: 'text_to_image',
    tool: 'generate_xai_grok_imagine_image',
    title: 'Grok Imagine',
    isDefault: false,
  },
]

const emptyImageCell: NotebookCell = {
  id: '01900000-0000-7000-8000-000000000001',
  type: 'generate_image',
  slug: 'generate-image-01',
  slot: { row: 0, column: 0 },
  prompt: '',
}

describe('notebook generation actions', () => {
  it('parses generation actions and ignores other catalog entries', () => {
    expect(asNotebookGenerationActions({
      actions: [
        {
          ...actions[0],
          kind: 'generation',
        },
        {
          ...actions[1],
          kind: 'local',
        },
      ],
    })).toEqual([actions[0]])
  })

  it('fills an incomplete generation cell from its catalog default', () => {
    expect(initialGenerationSelection(emptyImageCell, actions)).toEqual({
      provider: 'kie',
      model: 'GptImage2TextToImageRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_gpt_image_2_text_to_image',
    })
  })

  it('keeps dependent options valid when an upstream field changes', () => {
    const current = initialGenerationSelection(emptyImageCell, actions)!
    expect(generationActionFieldOptions(
      actions,
      'generate_image',
      current,
      'provider',
    )).toEqual(['kie', 'xai'])
    expect(changeGenerationSelection(
      actions,
      'generate_image',
      current,
      'provider',
      'xai',
    )).toEqual({
      provider: 'xai',
      model: 'XaiImageGenerateRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_xai_grok_imagine_image',
    })
  })

  it('preserves a configured non-default action', () => {
    expect(initialGenerationSelection({
      ...emptyImageCell,
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
    }, actions)).toEqual({
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
    })
  })
})
