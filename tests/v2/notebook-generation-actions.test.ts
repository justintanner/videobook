import { describe, expect, it } from 'vitest'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import { listNotebookActions } from '../../server/src/notebook-action-catalog'
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
  initialGenerationMode,
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
    id: 'generation.fal:fal-ai/nano-banana-pro/edit',
    cellTypes: ['generate_image'],
    provider: 'fal',
    providerLabel: 'Fal',
    model: 'fal:fal-ai/nano-banana-pro/edit',
    operation: 'edit_image',
    tool: 'generate_image',
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
  tool: 'generate_kie_seedance_2_5_video',
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
  id: 'generation.kling-omni-transformation',
  cellTypes: ['generate_video'],
  provider: 'kie',
  providerLabel: 'Kie',
  model: 'KlingOmniTransformationRequestSchema',
  operation: 'transformation',
  tool: 'generate_kie_kling_3_0_omni_transformation',
  title: 'Kling 3.0 Omni Transformation',
  isDefault: false,
  defaultPriority: null,
  inputContract: {
    modes: [{
      id: 'transformation',
      slots: [
        {
          field: 'image_refs',
          kind: 'image',
          targets: ['image'],
          min: 0,
          max: 4,
        },
        {
          field: 'video_refs',
          kind: 'video',
          targets: ['video'],
          min: 1,
          max: 1,
        },
      ],
      requiredGroups: [['video_refs']],
    }],
  },
  controls: [],
}

const emptyImageCell: NotebookCell = {
  id: '01900000-0000-7000-8000-000000000001',
  type: 'generate_image',
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
      'generate_image',
    ])
    expect(generationSelectionForAction(actions[1]!)).toEqual({
      provider: 'fal',
      model: 'fal:fal-ai/nano-banana-pro/edit',
      operation: 'edit_image',
      tool: 'generate_image',
    })
  })

  it('offers the fal 0.16.3 models for the inputs they accept', () => {
    const catalog = asNotebookGenerationActions({ actions: listNotebookActions() })
    const models = (
      type: 'generate_image' | 'generate_video',
      inputs: Array<{ kind: 'image' | 'video'; target: string }>,
    ) => compatibleGenerationActions(catalog, type, inputs).map((action) => action.model)

    expect(models('generate_video', [])).toContain('fal:blackforestlabs/flux-3-max/text-to-video')
    expect(models('generate_video', [])).not.toContain('fal:blackforestlabs/flux-3-max/image-to-video')
    expect(models('generate_video', [{ kind: 'image', target: 'image' }])).toContain(
      'fal:blackforestlabs/flux-3-max/keyframes-to-video',
    )
    expect(models('generate_video', [{ kind: 'image', target: 'first_frame' }])).toContain(
      'fal:blackforestlabs/flux-3-max/image-to-video',
    )
    expect(models('generate_video', [
      { kind: 'image', target: 'first_frame' },
      { kind: 'image', target: 'last_frame' },
    ])).toContain('fal:blackforestlabs/flux-3-max/image-to-video')
    expect(models('generate_video', [{ kind: 'video', target: 'video' }])).toContain(
      'fal:minimax/h3-max/reframe-video',
    )
    expect(models('generate_image', [])).toContain('fal:bria/fibo-2/generate')
    expect(models('generate_image', [{ kind: 'image', target: 'image' }])).toEqual(
      expect.arrayContaining(['fal:bria/fibo-2/generate', 'fal:bria/fibo-2/edit']),
    )
    expect(catalog.find((action) => action.id === 'image-edit.bria/fibo-2/edit')).toMatchObject({
      title: 'Fibo 2 Edit',
      provider: 'fal',
    })
  })

  it('offers the MachGen video models for the inputs each one accepts', () => {
    const catalog = asNotebookGenerationActions({ actions: listNotebookActions() })
    const machgen = (inputs: Array<{ kind: 'image' | 'video' | 'audio'; target: string }>) =>
      compatibleGenerationActions(catalog, 'generate_video', inputs)
        .filter((action) => action.provider === 'machgen')
        .map((action) => action.model)
        .sort()
    const all = [
      'machgen:Alibaba-Wan-3.0',
      'machgen:Grok-Imagine-Video',
      'machgen:Grok-Imagine-Video-1.5',
      'machgen:HappyHorse-1.0',
      'machgen:HappyHorse-1.1',
      'machgen:Kling-o3',
      'machgen:Kling-v3',
      'machgen:LTX-2.3-Pro',
      'machgen:MiniMax-H3',
      'machgen:MiniMax-H3-Turbo',
      'machgen:Pixverse-C1',
      'machgen:Pixverse-V6',
      'machgen:Seedance-2.0',
      'machgen:Seedance-2.0-Fast',
      'machgen:Seedance-2.0-Mini',
      'machgen:Seedance-2.5',
      'machgen:Veo-3.1',
      'machgen:Veo-3.1-Fast',
    ]
    const textOnly = ['machgen:Grok-Imagine-Video', 'machgen:Veo-3.1', 'machgen:Veo-3.1-Fast']
    const withFrames = all.filter((model) => !textOnly.includes(model))
    const withImages = withFrames.filter((model) => model !== 'machgen:Grok-Imagine-Video-1.5')

    expect(machgen([])).toEqual(all.filter((model) => model !== 'machgen:Grok-Imagine-Video-1.5'))
    expect(machgen([{ kind: 'image', target: 'first_frame' }])).toEqual(withFrames)
    const frames = [
      { kind: 'image' as const, target: 'first_frame' },
      { kind: 'image' as const, target: 'last_frame' },
    ]
    const modes = (model: string, inputs: Array<{ kind: 'image'; target: string }>) =>
      compatibleGenerationModes(catalog.find((action) => action.model === model)!, inputs).map((mode) => mode.id)
    expect(modes('machgen:MiniMax-H3', [frames[1]!])).toEqual(['i2v', 'r2v'])
    expect(modes('machgen:MiniMax-H3-Turbo', [frames[1]!])).toEqual(['i2v', 'r2v'])
    expect(modes('machgen:Kling-v3', frames)).toEqual(['i2v'])
    expect(modes('machgen:Pixverse-V6', frames)).toEqual(['r2v'])
    expect(modes('machgen:Seedance-2.5', [frames[1]!])).toEqual(['r2v'])
    expect(modes('machgen:Seedance-2.0', frames)).toEqual(['i2v', 'r2v'])
    expect(modes('machgen:HappyHorse-1.1', frames)).toEqual(['r2v'])
    expect(modes('machgen:Grok-Imagine-Video-1.5', frames)).toEqual([])
    expect(machgen([{ kind: 'image', target: 'image' }])).toEqual(withImages)
    expect(machgen([{ kind: 'video', target: 'video' }])).toEqual([
      'machgen:Alibaba-Wan-3.0',
      'machgen:MiniMax-H3',
      'machgen:MiniMax-H3-Turbo',
      'machgen:MiniMax-H3/upscale',
      'machgen:Seedance-2.0',
      'machgen:Seedance-2.0-Fast',
      'machgen:Seedance-2.0-Mini',
      'machgen:Seedance-2.5',
      'machgen:Topaz-Video-Generative',
      'machgen:Topaz-Video-Generative-Fast',
      'machgen:Topaz-Video-Precision',
      'machgen:Topaz-Video-Precision-Animation',
    ])
    expect(machgen([{ kind: 'audio', target: 'audio' }]))
      .toEqual(['machgen:Alibaba-Wan-3.0', 'machgen:MiniMax-H3', 'machgen:MiniMax-H3-Turbo', 'machgen:Seedance-2.5'])

    const h3 = catalog.find((action) => action.model === 'machgen:MiniMax-H3')!
    expect(generationActionLabel(h3)).toBe('MiniMax H3 (MachGen) · MachGen')
    expect(h3.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'resolution', kind: 'select', options: ['480p', '768p', '1440p'], defaultValue: '1440p' }),
      expect.objectContaining({ name: 'duration', kind: 'number', minimum: 1, maximum: 30, defaultValue: 12 }),
      expect.objectContaining({ name: 'generate_audio', kind: 'boolean', defaultValue: true }),
    ]))
    expect(catalog.find((action) => action.model === 'machgen:Alibaba-Wan-3.0')?.controls.map((control) => control.name))
      .toEqual(['duration', 'resolution', 'seed'])
  })

  it('offers the Seedance 2.5 draft completion as a Kie video model', () => {
    const catalog = asNotebookGenerationActions({ actions: listNotebookActions() })
    const draft = catalog.find((action) => action.model === 'kie:bytedance/seedance-2-5-draft')
    expect(draft).toMatchObject({ provider: 'kie', providerLabel: 'Kie', operation: 'upscale_video', title: 'Seedance 2.5 Draft Complete' })
    expect(draft?.controls).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'draft_task_id', kind: 'text', required: true }),
      expect.objectContaining({ name: 'resolution', kind: 'select', options: ['1080p'], defaultValue: '1080p' }),
    ]))
    expect(compatibleGenerationActions(catalog, 'generate_video', []).map((action) => action.model))
      .toContain('kie:bytedance/seedance-2-5-draft')
  })

  it('resolves saved edit models without offering workflow edits on new generation cells', () => {
    const catalog = asNotebookGenerationActions({ actions: listNotebookActions() })
    const selection = {
      tool: 'edit_image_subjects', provider: 'fal', model: 'fal-ai/nano-banana-pro/edit', operation: 'image_to_image',
    }
    expect(generationActionForSelection(catalog, 'generate_image', selection)?.id)
      .toBe('image-edit.fal-ai/nano-banana-pro/edit')
    expect(generationActionForSelection(catalog, 'generate_image', { ...selection, tool: '' })).toBeNull()
    expect(compatibleGenerationActions(catalog, 'generate_image', [{ kind: 'image', target: 'image' }])
      .some((action) => action.existingCellOnly)).toBe(false)
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

  it('omits unresolved descendant media that would create a cycle', () => {
    const target: NotebookCell = {
      ...emptyImageCell,
      type: 'generate_video',
    }
    const descendant: NotebookCell = {
      ...emptyImageCell,
      id: '01900000-0000-7000-8000-000000000016',
      type: 'image',
      slot: { row: 0, column: 1 },
    }
    const available: NotebookCell = {
      ...emptyImageCell,
      id: '01900000-0000-7000-8000-000000000017',
      type: 'image',
      slot: { row: 0, column: 2 },
    }
    const outputEdge: NotebookEdge = {
      id: '01900000-0000-7000-8000-000000000018',
      source: target.id,
      target: descendant.id,
      targetInput: 'media',
    }

    expect(generationInputAttachments(
      seedanceAction,
      'r2v',
      target.id,
      [target, descendant, available],
      [outputEdge],
    )).toEqual([{
      sourceCellId: available.id,
      targetInput: 'image',
      target: 'image',
      kind: 'image',
    }])
  })

  it('offers saved descendant images as additional inputs', () => {
    const target = { ...emptyImageCell, type: 'generate_video' as const }
    const image = {
      ...emptyImageCell,
      id: '01900000-0000-7000-8000-000000000016',
      type: 'image' as const,
      slot: { row: 0, column: 1 },
      outputArtifactId: '01900000-0000-7000-8000-000000000017',
    }
    const edge = {
      id: '01900000-0000-7000-8000-000000000018',
      source: target.id,
      target: image.id,
      targetInput: 'media',
    }
    expect(generationInputAttachments(
      seedanceAction,
      'r2v',
      target.id,
      [target, image],
      [edge],
    )).toEqual([{
      sourceCellId: image.id,
      targetInput: 'image',
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

  it('normalizes a generic image plus last frame into frame mode', () => {
    const inputs = [
      { kind: 'image' as const, target: 'image' },
      { kind: 'image' as const, target: 'last_frame' },
    ]
    expect(compatibleGenerationModes(seedanceAction, inputs)
      .map((mode) => mode.id)).toEqual(['i2v', 'r2v'])
    expect(initialGenerationMode(seedanceAction, inputs, 'default')).toBe('i2v')
    expect(compatibleGenerationModes(seedanceAction, [
      ...inputs,
      { kind: 'image', target: 'first_frame' },
    ]).map((mode) => mode.id)).toEqual(['r2v'])
  })

  it('offers Kling Omni transformation for a character image and motion video', () => {
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
      'generate_kie_kling_3_0_omni_transformation',
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
    ).map((action) => action.tool)).toEqual([geminiAction.tool, seedanceAction.tool])
    expect(compatibleGenerationActions(
      videoActions,
      'generate_video',
      [
        { kind: 'image', target: 'first_frame' },
        { kind: 'audio', target: 'audio' },
      ],
    ).map((action) => action.tool)).toEqual([seedanceAction.tool])
  })
})
