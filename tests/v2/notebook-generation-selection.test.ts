import { describe, expect, it } from 'vitest'
import {
  initialGenerationSelection,
  type NotebookGenerationAction,
} from '../../src/videobook/notebook-generation-actions'

const textToImage: NotebookGenerationAction = {
  cellTypes: ['generate_image'],
  provider: 'kie',
  model: 'GptImage2TextToImageRequestSchema',
  operation: 'text_to_image',
  tool: 'generate_kie_gpt_image_2_text_to_image',
  title: 'GPT Image text to image',
  isDefault: true,
}

const imageToImage: NotebookGenerationAction = {
  cellTypes: ['generate_image'],
  provider: 'kie',
  model: 'GptImage2ImageToImageRequestSchema',
  operation: 'image_to_image',
  tool: 'generate_kie_gpt_image_2_image_to_image',
  title: 'GPT Image image to image',
  isDefault: false,
}

const actions = [textToImage, imageToImage]
const unconfiguredCell = { type: 'generate_image' as const }

describe('initialGenerationSelection image-input default', () => {
  it('keeps the catalog default when no image input is connected', () => {
    expect(initialGenerationSelection(unconfiguredCell, actions)).toMatchObject({
      operation: 'text_to_image',
      tool: textToImage.tool,
    })
  })

  it('prefers an image-consuming action when an image input is connected', () => {
    expect(initialGenerationSelection(unconfiguredCell, actions, {
      hasImageInput: true,
    })).toMatchObject({
      operation: 'image_to_image',
      tool: imageToImage.tool,
    })
  })

  it('never overrides an explicitly configured tool', () => {
    expect(initialGenerationSelection({
      type: 'generate_image',
      tool: textToImage.tool,
    }, actions, { hasImageInput: true })).toMatchObject({
      operation: 'text_to_image',
      tool: textToImage.tool,
    })
  })

  it('falls back to the catalog default when no image-consuming action exists', () => {
    expect(initialGenerationSelection(unconfiguredCell, [textToImage], {
      hasImageInput: true,
    })).toMatchObject({
      tool: textToImage.tool,
    })
  })
})
