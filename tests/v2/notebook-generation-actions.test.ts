import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import {
  asNotebookGenerationActions,
  compatibleGenerationActions,
  generationActionForSelection,
  generationActionIsCompatible,
  generationActionLabel,
  generationConnectedInputs,
  generationSelectionForAction,
  initialGenerationSelection,
  type GenerationInputContract,
  type NotebookGenerationAction,
} from '../../src/videobook/notebook-generation-actions'

const textContract: GenerationInputContract = {
  modes: [{ id: 'text', slots: [], requiredGroups: [] }],
}

const optionalImageContract: GenerationInputContract = {
  modes: [{
    id: 'default',
    slots: [{
      field: 'image_slugs',
      kind: 'image',
      targets: ['image'],
      min: 0,
      max: 8,
    }],
    requiredGroups: [],
  }],
}

const actions: NotebookGenerationAction[] = [
  {
    id: 'generation.generate_kie_nano_banana_pro_text_to_image',
    cellTypes: ['generate_image'],
    provider: 'kie',
    providerLabel: 'Kie',
    model: 'NanoBananaProRequestSchema',
    operation: 'text_to_image',
    tool: 'generate_kie_nano_banana_pro_text_to_image',
    title: 'Nano Banana Pro',
    isDefault: true,
    defaultPriority: 0,
    inputContract: optionalImageContract,
  },
  {
    id: 'generation.generate_google_flow_nano_banana_pro_image',
    cellTypes: ['generate_image'],
    provider: 'google_flow',
    providerLabel: 'Google Flow',
    model: 'googleflow/image/nano-banana-pro',
    operation: 'text_to_image',
    tool: 'generate_google_flow_nano_banana_pro_image',
    title: 'Nano Banana Pro',
    isDefault: false,
    defaultPriority: null,
    inputContract: optionalImageContract,
  },
  {
    id: 'generation.generate_kie_gpt_image_2_text_to_image',
    cellTypes: ['generate_image'],
    provider: 'kie',
    providerLabel: 'Kie',
    model: 'GptImage2TextToImageRequestSchema',
    operation: 'text_to_image',
    tool: 'generate_kie_gpt_image_2_text_to_image',
    title: 'GPT Image 2',
    isDefault: false,
    defaultPriority: null,
    inputContract: textContract,
  },
]

const geminiAction: NotebookGenerationAction = {
  id: 'generation.gemini',
  cellTypes: ['generate_video'],
  provider: 'kie',
  providerLabel: 'Kie',
  model: 'GeminiOmniVideoRequestSchema',
  operation: 'image_to_video',
  tool: 'generate_kie_gemini_omni_video',
  title: 'Gemini Omni Video',
  isDefault: true,
  defaultPriority: 0,
  inputContract: {
    modes: [{
      id: 'default',
      slots: [
        {
          field: 'image_slugs',
          kind: 'image',
          targets: ['image'],
          min: 0,
          max: 7,
        },
        {
          field: 'video_slug',
          kind: 'video',
          targets: ['video'],
          min: 0,
          max: 1,
        },
      ],
      requiredGroups: [],
    }],
  },
}

const seedanceAction: NotebookGenerationAction = {
  id: 'generation.seedance',
  cellTypes: ['generate_video'],
  provider: 'kie',
  providerLabel: 'Kie',
  model: 'Seedance2InputSchema',
  operation: 'image_to_video',
  tool: 'generate_kie_seedance_2_0_video',
  title: 'Seedance 2',
  isDefault: false,
  defaultPriority: 1,
  inputContract: {
    modes: [
      { id: 'text', slots: [], requiredGroups: [] },
      {
        id: 'frames',
        slots: [
          {
            field: 'first_frame_slug',
            kind: 'image',
            targets: ['first_frame'],
            min: 0,
            max: 1,
          },
          {
            field: 'last_frame_slug',
            kind: 'image',
            targets: ['last_frame'],
            min: 0,
            max: 1,
          },
        ],
        requiredGroups: [],
      },
      {
        id: 'references',
        slots: [
          {
            field: 'image_slugs',
            kind: 'image',
            targets: ['image'],
            min: 0,
            max: 9,
          },
          {
            field: 'video_slugs',
            kind: 'video',
            targets: ['video'],
            min: 0,
            max: 3,
          },
          {
            field: 'audio_slugs',
            kind: 'audio',
            targets: ['audio'],
            min: 0,
            max: 3,
          },
        ],
        requiredGroups: [],
      },
    ],
  },
}

const emptyImageCell: NotebookCell = {
  id: '01900000-0000-7000-8000-000000000001',
  type: 'generate_image',
  slug: 'generate-image-01',
  slot: { row: 0, column: 0 },
  prompt: '',
}

describe('notebook generation actions', () => {
  it('parses the generation picker contract and ignores other actions', () => {
    expect(asNotebookGenerationActions({
      actions: [
        { ...actions[0], kind: 'generation' },
        { ...actions[1], kind: 'local' },
      ],
    })).toEqual([actions[0]])
  })

  it('uses the highest-priority compatible default', () => {
    expect(initialGenerationSelection(emptyImageCell, actions)).toEqual({
      provider: 'kie',
      model: 'NanoBananaProRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_nano_banana_pro_text_to_image',
    })
  })

  it('filters actions against connected media and preserves atomic tuples', () => {
    const imageInput = [{ kind: 'image' as const, target: 'image' }]
    expect(compatibleGenerationActions(
      actions,
      'generate_image',
      imageInput,
    ).map((action) => action.tool)).toEqual([
      'generate_kie_nano_banana_pro_text_to_image',
      'generate_google_flow_nano_banana_pro_image',
    ])
    expect(generationSelectionForAction(actions[1]!)).toEqual({
      provider: 'google_flow',
      model: 'googleflow/image/nano-banana-pro',
      operation: 'text_to_image',
      tool: 'generate_google_flow_nano_banana_pro_image',
    })
  })

  it('preserves a configured incompatible action until it is changed', () => {
    const selection = initialGenerationSelection({
      ...emptyImageCell,
      provider: 'kie',
      model: 'GptImage2TextToImageRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_gpt_image_2_text_to_image',
    }, actions, [{ kind: 'image', target: 'image' }])!
    const configured = generationActionForSelection(
      actions,
      'generate_image',
      selection,
    )!
    expect(configured.tool).toBe('generate_kie_gpt_image_2_text_to_image')
    expect(generationActionIsCompatible(
      configured,
      [{ kind: 'image', target: 'image' }],
    )).toBe(false)
  })

  it('maps connected cell types and role-specific targets', () => {
    const source: NotebookCell = {
      ...emptyImageCell,
      id: '01900000-0000-7000-8000-000000000002',
      type: 'image',
      slug: 'img-source',
    }
    const edge: NotebookEdge = {
      id: '01900000-0000-7000-8000-000000000003',
      source: source.id,
      target: emptyImageCell.id,
      targetInput: 'first_frame',
    }
    expect(generationConnectedInputs(
      emptyImageCell.id,
      [emptyImageCell, source],
      [edge],
    )).toEqual([{ kind: 'image', target: 'first_frame' }])
  })

  it('adds providers only when model titles collide', () => {
    expect(generationActionLabel(actions[0]!, actions)).toBe(
      'Nano Banana Pro · Kie',
    )
    expect(generationActionLabel(actions[2]!, actions)).toBe('GPT Image 2')
  })

  it('uses Gemini by default and Seedance for unsupported media combinations', () => {
    const videoActions = [geminiAction, seedanceAction]
    expect(compatibleGenerationActions(
      videoActions,
      'generate_video',
      [],
    ).map((action) => action.tool)).toEqual([
      geminiAction.tool,
      seedanceAction.tool,
    ])
    expect(compatibleGenerationActions(
      videoActions,
      'generate_video',
      [{ kind: 'audio', target: 'audio' }],
    ).map((action) => action.tool)).toEqual([seedanceAction.tool])
    expect(compatibleGenerationActions(
      videoActions,
      'generate_video',
      [
        { kind: 'image', target: 'image' },
        { kind: 'video', target: 'video' },
      ],
    ).map((action) => action.tool)).toEqual([
      geminiAction.tool,
      seedanceAction.tool,
    ])
    expect(compatibleGenerationActions(
      videoActions,
      'generate_video',
      [
        { kind: 'image', target: 'first_frame' },
        { kind: 'image', target: 'last_frame' },
      ],
    ).map((action) => action.tool)).toEqual([seedanceAction.tool])
    expect(compatibleGenerationActions(
      videoActions,
      'generate_video',
      [
        { kind: 'image', target: 'first_frame' },
        { kind: 'audio', target: 'audio' },
      ],
    )).toEqual([])
  })
})
