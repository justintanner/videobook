import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import {
  asNotebookGenerationActions,
  compatibleGenerationActions,
  compatibleGenerationModes,
  effectiveGenerationSettings,
  generationActionForSelection,
  generationActionIsCompatible,
  generationActionLabel,
  generationConnectedInputs,
  generationInputKind,
  generationInputAttachments,
  generationModeLabel,
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
    controls: [{
      name: 'aspect_ratio',
      label: 'Aspect ratio',
      kind: 'select',
      valueType: 'string',
      required: false,
      defaultValue: 'auto',
      options: ['auto', '16:9', '9:16'],
      description: 'Output aspect ratio',
    }],
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
    controls: [],
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
    controls: [],
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
    modes: [
      { id: 't2v', slots: [], requiredGroups: [] },
      {
        id: 'r2v',
        slots: [{
          field: 'image_slugs',
          kind: 'image',
          targets: ['image'],
          min: 0,
          max: 7,
        }],
        requiredGroups: [['image_slugs']],
      },
      {
        id: 'v2v',
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
        requiredGroups: [['video_slug']],
      },
    ],
  },
  controls: [],
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
      { id: 't2v', slots: [], requiredGroups: [] },
      {
        id: 'i2v',
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
        requiredGroups: [['first_frame_slug', 'last_frame_slug']],
      },
      {
        id: 'r2v',
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
        requiredGroups: [['image_slugs', 'video_slugs', 'audio_slugs']],
      },
    ],
  },
  controls: [],
}

const motionControlAction: NotebookGenerationAction = {
  id: 'generation.kling-motion-control',
  cellTypes: ['generate_video'],
  provider: 'kie',
  providerLabel: 'Kie',
  model: 'KlingMotionControlRequestSchema',
  operation: 'motion_control',
  tool: 'generate_kie_kling_3_0_motion_control',
  title: 'Kling 3.0 Motion Control',
  isDefault: false,
  defaultPriority: null,
  inputContract: {
    modes: [{
      id: 'default',
      slots: [
        {
          field: 'character_image_slugs',
          kind: 'image',
          targets: ['image'],
          min: 1,
          max: 1,
        },
        {
          field: 'motion_video_slugs',
          kind: 'video',
          targets: ['video'],
          min: 1,
          max: 1,
        },
      ],
      requiredGroups: [],
    }],
  },
  controls: [],
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

  it('offers unconnected media through an open generation input', () => {
    const target: NotebookCell = {
      ...emptyImageCell,
      type: 'generate_video',
    }
    const video: NotebookCell = {
      ...emptyImageCell,
      id: '01900000-0000-7000-8000-000000000010',
      type: 'video',
      slot: { row: 0, column: 0 },
    }
    const image: NotebookCell = {
      ...emptyImageCell,
      id: '01900000-0000-7000-8000-000000000011',
      type: 'image',
      slot: { row: 0, column: 1 },
    }
    const edge: NotebookEdge = {
      id: '01900000-0000-7000-8000-000000000012',
      source: video.id,
      target: target.id,
      targetInput: 'video',
    }

    expect(generationInputAttachments(
      seedanceAction,
      'r2v',
      target.id,
      [target, image, video],
      [edge],
    )).toEqual([{
      sourceCellId: image.id,
      targetInput: 'image',
      target: 'image',
      kind: 'image',
    }])
  })

  it('allocates a new named input without replacing an existing reference', () => {
    const target: NotebookCell = {
      ...emptyImageCell,
      type: 'generate_video',
    }
    const firstImage: NotebookCell = {
      ...emptyImageCell,
      id: '01900000-0000-7000-8000-000000000013',
      type: 'image',
    }
    const nextImage: NotebookCell = {
      ...emptyImageCell,
      id: '01900000-0000-7000-8000-000000000014',
      type: 'image',
      slot: { row: 0, column: 1 },
    }
    const edge: NotebookEdge = {
      id: '01900000-0000-7000-8000-000000000015',
      source: firstImage.id,
      target: target.id,
      targetInput: 'image',
    }

    expect(generationInputAttachments(
      seedanceAction,
      'r2v',
      target.id,
      [target, firstImage, nextImage],
      [edge],
    )).toEqual([{
      sourceCellId: nextImage.id,
      targetInput: 'image_2',
      target: 'image',
      kind: 'image',
    }])
  })

  it('treats extracted-frame image cells as image sources', () => {
    const extractedFrame: NotebookCell = {
      ...emptyImageCell,
      id: '01900000-0000-7000-8000-000000000004',
      type: 'image',
      inputs: { mediaRole: 'extract-frame-output', frameMode: 'first' },
    }
    const edge: NotebookEdge = {
      id: '01900000-0000-7000-8000-000000000005',
      source: extractedFrame.id,
      target: emptyImageCell.id,
      targetInput: 'image',
    }
    expect(generationInputKind(extractedFrame)).toBe('image')
    expect(generationConnectedInputs(
      emptyImageCell.id,
      [emptyImageCell, extractedFrame],
      [edge],
    )).toEqual([{
      kind: 'image',
      target: 'image',
    }])
  })

  it('adds providers to every model label', () => {
    expect(generationActionLabel(actions[0]!)).toBe('Nano Banana Pro · Kie')
    expect(generationActionLabel(actions[2]!)).toBe('GPT Image 2 · Kie')
  })

  it('surfaces compatible generation types with concise labels', () => {
    expect(compatibleGenerationModes(
      geminiAction,
      [{ kind: 'video', target: 'video' }],
    ).map((mode) => mode.id)).toEqual(['v2v'])
    expect(generationModeLabel('r2v')).toBe('R2V · Reference to video')
  })

  it('offers Kling motion control for a character image and motion video', () => {
    expect(compatibleGenerationActions(
      [motionControlAction],
      'generate_video',
      [{ kind: 'image', target: 'image' }],
    )).toEqual([])
    expect(compatibleGenerationActions(
      [motionControlAction],
      'generate_video',
      [
        { kind: 'image', target: 'image' },
        { kind: 'video', target: 'video' },
      ],
    ).map((action) => action.tool)).toEqual([
      'generate_kie_kling_3_0_motion_control',
    ])
  })

  it('materializes control defaults alongside explicit settings', () => {
    expect(effectiveGenerationSettings([
      {
        name: 'duration',
        label: 'Duration',
        kind: 'number',
        valueType: 'number',
        required: true,
        defaultValue: 6,
        options: [],
        description: 'Duration',
      },
      {
        name: 'resolution',
        label: 'Resolution',
        kind: 'select',
        valueType: 'string',
        required: false,
        defaultValue: '480p',
        options: ['480p', '720p'],
        description: 'Resolution',
      },
      {
        name: 'aspect_ratio',
        label: 'Aspect ratio',
        kind: 'select',
        valueType: 'string',
        required: false,
        defaultValue: '16:9',
        options: ['16:9', '9:16'],
        description: 'Aspect ratio',
      },
      {
        name: 'nsfw_checker',
        label: 'NSFW checker',
        kind: 'boolean',
        valueType: 'boolean',
        required: false,
        defaultValue: false,
        options: [],
        description: 'NSFW checker',
      },
    ], {
      aspect_ratio: '9:16',
    })).toEqual({
      duration: 6,
      resolution: '480p',
      aspect_ratio: '9:16',
      nsfw_checker: false,
    })
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
