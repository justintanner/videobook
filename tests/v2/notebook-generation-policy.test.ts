import type { NotebookCellType } from 'videobook-engine'
import { describe, expect, it } from 'vitest'
import {
  notebookCellRequiresCloudGenerationConsent,
  notebookCellSupportsGenerateCellCommand,
} from '../../src/videobook/notebook-generation-policy'

const generationTypes = [
  'generate_audio',
  'generate_image',
  'generate_video',
] satisfies NotebookCellType[]

const localTypes = [
  'audio',
  'image',
  'video',
  'extract_audio',
  'split_video',
  'prompt',
] satisfies NotebookCellType[]

describe('notebook generation policy', () => {
  it('runs local subject removal without cloud consent', () => {
    expect(notebookCellRequiresCloudGenerationConsent({
      type: 'generate_image', tool: 'edit_image_subjects', provider: 'local',
    })).toBe(false)
    expect(notebookCellRequiresCloudGenerationConsent({
      type: 'generate_image', tool: 'edit_image_subjects', provider: 'fal',
    })).toBe(true)
  })
  it('requires cloud consent for prompt rewrites without accepting them as generate-cell targets', () => {
    const cell = { type: 'prompt' as const, operation: 'rewrite_prompt' }

    expect(notebookCellRequiresCloudGenerationConsent(cell)).toBe(true)
    expect(notebookCellSupportsGenerateCellCommand(cell)).toBe(false)
  })

  it.each(generationTypes)('accepts %s cells for cloud generation commands', (type) => {
    const cell = { type, operation: 'generate' }

    expect(notebookCellRequiresCloudGenerationConsent(cell)).toBe(true)
    expect(notebookCellSupportsGenerateCellCommand(cell)).toBe(true)
  })

  it.each(localTypes)('keeps %s cells outside cloud generation policy', (type) => {
    const cell = { type, operation: 'process' }

    expect(notebookCellRequiresCloudGenerationConsent(cell)).toBe(false)
    expect(notebookCellSupportsGenerateCellCommand(cell)).toBe(false)
  })

  it('rejects rewrite operations even when attached to a generation cell type', () => {
    const cell = { type: 'generate_video' as const, operation: 'rewrite_prompt' }

    expect(notebookCellRequiresCloudGenerationConsent(cell)).toBe(true)
    expect(notebookCellSupportsGenerateCellCommand(cell)).toBe(false)
  })
})
