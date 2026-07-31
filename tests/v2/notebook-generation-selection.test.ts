import { describe, expect, it } from 'vitest'
import {
  initialGenerationSelection,
  type GenerationInputContract,
  type NotebookGenerationAction,
} from '../../src/videobook/notebook-generation-actions'

const textContract: GenerationInputContract = {
  modes: [{ id: 'text', slots: [], requiredGroups: [] }],
}

const requiredImageContract: GenerationInputContract = {
  modes: [{
    id: 'edit',
    slots: [{
      field: 'image_slugs',
      kind: 'image',
      targets: ['image'],
      min: 1,
      max: 8,
    }],
    requiredGroups: [],
  }],
}

const textToImage: NotebookGenerationAction = {
  id: 'generation.text',
  cellTypes: ['generate_image'],
  provider: 'kie',
  providerLabel: 'Kie',
  model: 'GptImage2TextToImageRequestSchema',
  operation: 'text_to_image',
  tool: 'generate_kie_gpt_image_2_text_to_image',
  title: 'GPT Image 2',
  isDefault: true,
  defaultPriority: 0,
  inputContract: textContract,
}

const imageToImage: NotebookGenerationAction = {
  id: 'generation.edit',
  cellTypes: ['generate_image'],
  provider: 'kie',
  providerLabel: 'Kie',
  model: 'GptImage2ImageToImageRequestSchema',
  operation: 'image_to_image',
  tool: 'generate_kie_gpt_image_2_image_to_image',
  title: 'GPT Image 2 Edit',
  isDefault: false,
  defaultPriority: 1,
  inputContract: requiredImageContract,
}

const actions = [textToImage, imageToImage]
const unconfiguredCell = { type: 'generate_image' as const }

describe('initialGenerationSelection input compatibility', () => {
  it('keeps the text default when no media is connected', () => {
    expect(initialGenerationSelection(unconfiguredCell, actions)).toMatchObject({
      tool: textToImage.tool,
    })
  })

  it('chooses an image-consuming action for an image input', () => {
    expect(initialGenerationSelection(
      unconfiguredCell,
      actions,
      [{ kind: 'image', target: 'image' }],
    )).toMatchObject({
      tool: imageToImage.tool,
    })
  })

  it('does not silently replace an explicitly configured action', () => {
    expect(initialGenerationSelection({
      type: 'generate_image',
      tool: textToImage.tool,
    }, actions, [{ kind: 'image', target: 'image' }])).toMatchObject({
      tool: textToImage.tool,
    })
  })

  it('returns no default when no action accepts the inputs', () => {
    expect(initialGenerationSelection(
      unconfiguredCell,
      [textToImage],
      [{ kind: 'image', target: 'image' }],
    )).toBeNull()
  })
})
