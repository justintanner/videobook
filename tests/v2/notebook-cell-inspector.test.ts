import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  NOTEBOOK_CELL_TYPES,
  type NotebookCell,
  type NotebookEdge,
} from 'videobook-engine'
import { notebookGridAddress } from 'videobook-engine/notebook-grid'
import { NotebookCellInspector } from '../../src/components/videobook/NotebookCellInspector'
import { NotebookMediaFullscreen } from '../../src/components/videobook/NotebookMediaFullscreen'
import {
  persistAndRunNotebookCell,
  startNotebookCellRun,
} from '../../src/videobook/notebook-cell-actions'
import {
  doltCellDisplayValue,
  doltCellRows,
} from '../../src/videobook/dolt-cell-source'
import type {
  GenerationInputContract,
  NotebookGenerationAction,
} from '../../src/videobook/notebook-generation-actions'
import type { ElevenLabsVoicesState } from '../../src/videobook/use-elevenlabs-voices'
import { asImageSubjectMap } from '../../src/videobook/image-subject-map'

const cell: NotebookCell = {
  id: '01900000-0000-7000-8000-000000000001',
  type: 'video',
  label: 'vid-source',
  slot: { row: 1, column: 2 },
  inputs: {
    operation: 'download_video',
    selectedRangeSeconds: [1490, 1550],
  },
  outputArtifactId: '01900000-0000-7000-8000-000000000002',
}

const textContract: GenerationInputContract = {
  modes: [{ id: 'text', slots: [], requiredGroups: [] }],
}

const optionalImageContract: GenerationInputContract = {
  modes: [{
    id: 'default',
    slots: [{
      field: 'image_refs',
      kind: 'image',
      targets: ['image'],
      min: 0,
      max: 8,
    }],
    requiredGroups: [],
  }],
}

const generationActions: NotebookGenerationAction[] = [
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
    id: 'generation.generate_kie_gemini_omni_video',
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
            field: 'image_refs',
            kind: 'image',
            targets: ['image'],
            min: 0,
            max: 7,
          }],
          requiredGroups: [['image_refs']],
        },
        {
          id: 'v2v',
          slots: [
            {
              field: 'image_refs',
              kind: 'image',
              targets: ['image'],
              min: 0,
              max: 7,
            },
            {
              field: 'video_ref',
              kind: 'video',
              targets: ['video'],
              min: 0,
              max: 1,
            },
          ],
          requiredGroups: [['video_ref']],
        },
      ],
    },
    controls: [
      {
        name: 'duration',
        label: 'Duration',
        kind: 'select',
        valueType: 'string',
        required: true,
        defaultValue: '8',
        options: ['4', '6', '8', '10'],
        description: 'Output duration',
      },
      {
        name: 'aspect_ratio',
        label: 'Aspect ratio',
        kind: 'select',
        valueType: 'string',
        required: false,
        options: ['16:9', '9:16'],
        description: 'Output aspect ratio',
      },
      {
        name: 'resolution',
        label: 'Resolution',
        kind: 'select',
        valueType: 'string',
        required: false,
        options: ['720p', '1080p', '4k'],
        description: 'Output resolution',
      },
    ],
  },
  {
    id: 'generation.generate_elevenlabs_text_to_audio',
    cellTypes: ['generate_audio'],
    provider: 'elevenlabs',
    providerLabel: 'ElevenLabs',
    model: '@apicity/elevenlabs',
    operation: 'text_to_audio',
    tool: 'generate_elevenlabs_text_to_audio',
    title: 'ElevenLabs',
    isDefault: true,
    defaultPriority: 0,
    inputContract: textContract,
    controls: [
      {
        name: 'voice_id',
        label: 'Voice id',
        kind: 'text',
        valueType: 'string',
        required: true,
        options: [],
        description: 'ElevenLabs voice ID',
      },
      {
        name: 'asset_name',
        label: 'Asset name',
        kind: 'text',
        valueType: 'string',
        required: false,
        options: [],
        description: 'Optional output audio asset name',
      },
    ],
  },
]

const voiceCatalog: ElevenLabsVoicesState = {
  voices: [
    {
      voiceId: 'voice-a',
      name: 'Ada',
      source: 'custom',
      category: 'cloned',
      previewUrl: 'https://example.test/ada.mp3',
    },
    {
      voiceId: 'voice-b',
      name: 'Bella',
      source: 'generic',
      category: 'premade',
      previewUrl: 'https://example.test/bella.mp3',
    },
  ],
  status: 'live',
  warning: null,
  loading: false,
  error: null,
  ensureLoaded: async () => null,
  refresh: async () => null,
}

describe('NotebookCellInspector', () => {
  it('renders the ElevenLabs voice picker for generate_audio cells', () => {
    const generationCell: NotebookCell = {
      ...cell,
      type: 'generate_audio',
      label: 'generate-audio-01',
      prompt: 'welcome back everyone',
      provider: undefined,
      model: undefined,
      operation: undefined,
      tool: undefined,
      outputArtifactId: undefined,
      inputs: { generationSettings: { voice_id: 'voice-b' } },
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: generationCell,
      cells: [generationCell],
      edges: [],
      asset: undefined,
      status: 'ready',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      generationActions,
      voiceCatalog,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('data-testid="inspector-voice-picker"')
    expect(html).toContain('Ada')
    expect(html).toContain('Bella')
    expect(html).toContain('custom · cloned')
    expect(html).toContain('Preview')
    expect(html).toContain('speak-preview-voice selected')
    expect(html).toContain('data-voice-id="voice-b"')
    expect(html).not.toContain('aria-label="Voice id"')
    expect(html).toContain('aria-label="Asset name"')
    expect(html).toContain('Refresh voices')
  })

  it('falls back to the voice_id text field without a voice catalog', () => {
    const generationCell: NotebookCell = {
      ...cell,
      type: 'generate_audio',
      label: 'generate-audio-02',
      prompt: 'welcome back everyone',
      provider: undefined,
      model: undefined,
      operation: undefined,
      tool: undefined,
      outputArtifactId: undefined,
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: generationCell,
      cells: [generationCell],
      edges: [],
      asset: undefined,
      status: 'ready',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      generationActions,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).not.toContain('data-testid="inspector-voice-picker"')
    expect(html).toContain('aria-label="Voice id"')
  })

  it('defaults generation configuration to one catalog-backed model picker', () => {
    const generationCell: NotebookCell = {
      ...cell,
      type: 'generate_image',
      label: 'generate-image-01',
      prompt: '',
      provider: undefined,
      model: undefined,
      operation: undefined,
      tool: undefined,
      outputArtifactId: undefined,
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: generationCell,
      cells: [generationCell],
      edges: [],
      asset: undefined,
      status: 'ready',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      generationActions,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('<select aria-label="Model">')
    expect(html).toContain(
      '<option value="generation.generate_kie_nano_banana_pro_text_to_image" selected="">Nano Banana Pro · Kie</option>',
    )
    expect(html).not.toContain('<select aria-label="Provider">')
    expect(html).not.toContain('<select aria-label="Operation">')
    expect(html).not.toContain('<select aria-label="Tool">')
    expect(html).toContain(
      'class="inspector-cell-form inspector-generation-form"',
    )
    expect(html).toContain('class="inspector-generation-model"')
    expect(html).toContain('Changes apply when you generate')
    expect(html).toContain(
      'class="inspector-cell-actions inspector-generation-actions"',
    )
    expect(html).toContain('Generate')
    expect(html).not.toContain('Save changes')
    expect(html).toContain('inspector-delete-cell-button')
    expect(html).toContain('Delete cell')
    expect(html).not.toContain('Choose a generation tool')
    expect(html).not.toContain('placeholder="Provider"')
  })

  it('shows generation type and schema-backed video controls', () => {
    const generationCell: NotebookCell = {
      ...cell,
      type: 'generate_video',
      label: 'generate-video-01',
      prompt: 'A moonlit garden',
      provider: undefined,
      model: undefined,
      operation: undefined,
      tool: undefined,
      outputArtifactId: undefined,
    }
    let previewCalls = 0
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: generationCell,
      cells: [generationCell],
      edges: [],
      asset: undefined,
      status: 'ready',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      generationActions,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
      onPreviewPayload: async () => {
        previewCalls += 1
        return {}
      },
    }))

    expect(html).toContain('Gemini Omni Video · Kie')
    expect(html).toContain('<select aria-label="Type">')
    expect(html).toContain('T2V · Text to video')
    expect(html).toContain('<select aria-label="Duration">')
    expect(html).toContain('Default · 8')
    expect(html).toContain('<select aria-label="Aspect ratio">')
    expect(html).toContain('<select aria-label="Resolution">')
    expect(html).toContain(
      'class="inspector-analysis-json-disclosure inspector-payload-disclosure"',
    )
    expect(html).toContain('class="inspector-json-summary"')
    expect(html).toContain(
      '{&quot;provider&quot;:&quot;Kie&quot;,&quot;model&quot;:&quot;Gemini Omni Video&quot;,&quot;type&quot;:&quot;t2v&quot;,&quot;inputs&quot;:0,&quot;settings&quot;:{&quot;duration&quot;:&quot;8&quot;}}',
    )
    expect(previewCalls).toBe(0)
  })

  it('offers compatible notebook media as an additional generation input', () => {
    const generationCell: NotebookCell = {
      ...cell,
      id: '01900000-0000-7000-8000-000000000030',
      type: 'generate_video',
      slot: { row: 1, column: 0 },
      prompt: 'Two kittens perform the reference dance',
      provider: 'kie',
      model: 'GeminiOmniVideoRequestSchema',
      operation: 'image_to_video',
      tool: 'generate_kie_gemini_omni_video',
      inputs: { generationMode: 'v2v' },
      outputArtifactId: undefined,
    }
    const videoSource: NotebookCell = {
      ...cell,
      id: '01900000-0000-7000-8000-000000000031',
      slot: { row: 0, column: 0 },
    }
    const imageSource: NotebookCell = {
      ...cell,
      id: '01900000-0000-7000-8000-000000000032',
      type: 'image',
      slot: { row: 0, column: 1 },
    }
    const edge: NotebookEdge = {
      id: '01900000-0000-7000-8000-000000000033',
      source: videoSource.id,
      target: generationCell.id,
      targetInput: 'video',
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: generationCell,
      cells: [generationCell, videoSource, imageSource],
      edges: [edge],
      asset: undefined,
      status: 'ready',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      generationActions,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('aria-label="video input"')
    expect(html).toContain('aria-label="Attach media input"')
    expect(html).toContain('role="listbox" aria-label="Media input options"')
    expect(html).toContain('<strong>@a2</strong>')
    expect(html).toContain('image · image input')
    expect(html).not.toContain('<strong>@a1</strong><small>image')
  })

  it('keeps an incompatible saved model visible and disables generation', () => {
    const generationCell: NotebookCell = {
      ...cell,
      type: 'generate_image',
      label: 'generate-image-01',
      prompt: 'Edit this image',
      provider: 'kie',
      model: 'GptImage2TextToImageRequestSchema',
      operation: 'text_to_image',
      tool: 'generate_kie_gpt_image_2_text_to_image',
      outputArtifactId: undefined,
    }
    const sourceCell: NotebookCell = {
      ...cell,
      id: '01900000-0000-7000-8000-000000000020',
      type: 'image',
      label: 'img-source',
      outputArtifactId: '01900000-0000-7000-8000-000000000021',
    }
    const edge: NotebookEdge = {
      id: '01900000-0000-7000-8000-000000000022',
      source: sourceCell.id,
      target: generationCell.id,
      targetInput: 'input',
    }
    let previewCalls = 0
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: generationCell,
      cells: [generationCell, sourceCell],
      edges: [edge],
      asset: undefined,
      status: 'ready',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      generationActions,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
      onPreviewPayload: async () => {
        previewCalls += 1
        return {}
      },
    }))

    expect(html).toContain(
      '<option value="generation.generate_kie_gpt_image_2_text_to_image" selected="">GPT Image 2 · Kie · incompatible</option>',
    )
    expect(html).toContain('This model does not accept the current inputs.')
    expect(html).toMatch(/class="inspector-run-action"[^>]*disabled=""/)
    expect(html).toContain(
      'class="inspector-analysis-json-disclosure inspector-payload-disclosure"',
    )
    expect(html).not.toContain('class="inspector-analysis-json-scroll"')
    expect(previewCalls).toBe(0)
  })

  it.each(NOTEBOOK_CELL_TYPES)(
    'renders Video-style cleanup actions for %s cells',
    (type) => {
      const typedCell: NotebookCell = {
        ...cell,
        type,
      }
      const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
        notebookId: '01900000-0000-7000-8000-000000000003',
        cell: typedCell,
        cells: [typedCell],
        edges: [],
        asset: undefined,
        status: 'completed',
        error: null,
        busy: false,
        deleting: false,
        sourceVisible: false,
        generationActions,
        onUpdate: async () => undefined,
        onSetInput: async () => undefined,
        onRun: async () => undefined,
        onDelete: async () => undefined,
        onOpenFullscreen: () => undefined,
      }))

      expect(html).toContain(
        'class="inspector-cell-actions inspector-compact-actions" aria-label="Cell cleanup actions"',
      )
      expect(html).toContain('inspector-delete-cell-button')
    },
  )

  it('renders output media without requiring an open action', () => {
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell,
      cells: [cell],
      edges: [],
      asset: {
        artifactId: cell.outputArtifactId!,
        id: 'vid-source',
        type: 'video',
        mediaUrl: '/files/vid-source/original.mp4',
        thumbnailUrl: '/files/vid-source/original.jpg',
        width: 1920,
        height: 1080,
        duration: 30,
        audioInfo: null,
      },
      status: 'completed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('<video')
    expect(html).toContain('preload="metadata"')
    expect(html).toContain('controls=""')
    expect(html).toContain('/files/vid-source/original.mp4')
    expect(html).toContain('class="notebook-media-metadata inspector-cell-metadata"')
    expect(html).toContain('<span>1920×1080</span>')
    expect(html).toContain('dateTime="PT30S"')
    expect(html).toContain('aria-label="Duration 0:30"')
    expect(html).not.toContain('role="tab"')
    expect(html).not.toContain('<label>Address</label>')
    expect(html).toContain('class="inspector-media-field-label">VIDEO</span>')
    expect(html).toContain('<h3>Inputs</h3>')
    expect(html.indexOf('class="inspector-media-field-label"')).toBeLessThan(
      html.indexOf('aria-label="Cell output media"'),
    )
    expect(html.indexOf('aria-label="Cell output media"')).toBeLessThan(
      html.indexOf('<h3>Inputs</h3>'),
    )
    expect(html).not.toContain('Dolt source')
    expect(html).toContain('inspector-delete-cell-button')
    expect(html).toContain('Delete cell')
    expect(html).not.toContain('completed')
    expect(html).toContain(
      'class="inspector-cell-actions inspector-compact-actions" aria-label="Cell cleanup actions"',
    )
    expect(html).not.toContain('record-card-actions inspector-media-actions')
    expect(html.indexOf('<h3>Inputs</h3>')).toBeLessThan(
      html.indexOf('class="inspector-cell-actions inspector-compact-actions"'),
    )
    expect(html).toContain('aria-label="Open @b3 fullscreen"')
    expect(html).not.toContain('aria-label="Edit @b3 image"')
  })

  it('renders compact image edit and fullscreen actions for the same viewer', () => {
    const imageCell: NotebookCell = {
      ...cell,
      type: 'image',
      label: 'image-output',
      slot: { row: 6, column: 4 },
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: imageCell,
      cells: [imageCell],
      edges: [],
      asset: {
        artifactId: imageCell.outputArtifactId!,
        id: 'image-output',
        type: 'image',
        mediaUrl: '/files/image-output/original.png',
        thumbnailUrl: null,
        width: 1536,
        height: 1024,
        duration: null,
        audioInfo: null,
      },
      status: 'completed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain(
      'class="inspector-media-content inspector-image-media-content"',
    )
    expect(html).toContain(
      'class="inspector-media-actions inspector-media-actions-image"',
    )
    expect(html).toContain('aria-label="Image preview actions"')
    expect(html).toContain('aria-label="Edit @g5 image"')
    expect(html).toContain('aria-label="Open @g5 fullscreen"')
    expect(html.indexOf('aria-label="Edit @g5 image"')).toBeLessThan(
      html.indexOf('aria-label="Open @g5 fullscreen"'),
    )
  })

  it('opens generated video output in the shared fullscreen viewer', () => {
    const generationCell: NotebookCell = {
      ...cell,
      type: 'generate_video',
      label: 'generated-video',
      prompt: 'A cat running on a track',
      provider: 'kie',
      model: 'GeminiOmniVideoRequestSchema',
      operation: 'image_to_video',
      tool: 'generate_kie_gemini_omni_video',
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: generationCell,
      cells: [generationCell],
      edges: [],
      asset: {
        artifactId: generationCell.outputArtifactId!,
        id: 'generated-video',
        type: 'video',
        mediaUrl: '/files/generated-video/original.mp4',
        thumbnailUrl: '/files/generated-video/original.jpg',
        width: 3840,
        height: 2160,
        duration: 9,
        audioInfo: null,
      },
      status: 'completed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      generationActions,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('aria-label="Open @b3 fullscreen"')
    expect(html).toContain('<span>3840×2160</span>')
    expect(html).toContain('<svg')
    expect(html).toContain('Fullscreen</button>')
  })

  it('marks audio output for a compact media preview', () => {
    const audioCell: NotebookCell = {
      ...cell,
      type: 'audio',
      label: 'aud-source',
      inputs: {
        audioRole: 'continuous-source',
      },
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: audioCell,
      cells: [audioCell],
      edges: [],
      asset: {
        artifactId: audioCell.outputArtifactId!,
        id: 'aud-source',
        type: 'audio',
        mediaUrl: '/files/aud-source/original.m4a',
        thumbnailUrl: null,
        width: null,
        height: null,
        duration: 60.01,
        audioInfo: {
          channelLayout: 'stereo',
          channels: 2,
          codec: 'aac',
          durationSeconds: 60.01,
          sampleRateHz: 48_000,
        },
      },
      status: 'completed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('class="inspector-cell-preview inspector-cell-preview-audio"')
    expect(html).toContain('<audio')
    expect(html).toContain('/files/aud-source/original.m4a')
    expect(html).toContain('class="inspector-audio-role">Audio output</span>')
    expect(html).toContain('<dt>Duration</dt><dd>1:00.01</dd>')
    expect(html).toContain('<dt>Format</dt><dd>AAC · 48 kHz · stereo</dd>')
    expect(html).not.toContain('aria-label="Audio version"')
    expect(html).not.toContain('aria-label="Open @b3 fullscreen"')
    expect(html).not.toContain('aria-label="Edit @b3 image"')
  })

  it('labels and selects the current saved audio version', () => {
    const audioCell: NotebookCell = {
      ...cell,
      type: 'audio',
      label: 'aud-source',
      inputs: {
        audioRole: 'continuous-source',
        outputVersionArtifactIds: ['audio-one', 'audio-two'],
      },
      outputArtifactId: 'audio-two',
    }
    const currentAsset = {
      artifactId: 'audio-two',
      id: 'aud-source-2',
      type: 'audio',
      mediaUrl: '/files/aud-source-2/original.m4a',
      thumbnailUrl: null,
      width: null,
      height: null,
      duration: 30,
      audioInfo: {
        channelLayout: 'stereo',
        channels: 2,
        codec: 'aac',
        durationSeconds: 30,
        sampleRateHz: 48_000,
      },
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: audioCell,
      cells: [audioCell],
      edges: [],
      asset: currentAsset,
      versionAssets: [
        {
          ...currentAsset,
          artifactId: 'audio-one',
          id: 'aud-source-1',
          mediaUrl: '/files/aud-source-1/original.m4a',
          duration: 15,
          audioInfo: {
            ...currentAsset.audioInfo,
            durationSeconds: 15,
          },
        },
        currentAsset,
      ],
      status: 'completed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('aria-label="Audio versions"')
    expect(html).toContain('aria-label="Audio version"')
    expect(html).toContain('Version 1 of 2')
    expect(html).toContain('Version 2 of 2 · current')
    expect(html).toContain('Current output')
    expect(html).toContain('value="audio-two" selected=""')
    expect(html).toContain('/files/aud-source-2/original.m4a')
    expect(html).toContain('<dt>Duration</dt><dd>0:30</dd>')
  })

  it('labels and selects the current saved image version', () => {
    const imageCell: NotebookCell = {
      ...cell,
      type: 'image',
      label: 'img-frame',
      inputs: {
        frameMode: 'time',
        atSeconds: 1.25,
        outputVersionArtifactIds: ['image-one', 'image-two'],
      },
      outputArtifactId: 'image-two',
    }
    const currentAsset = {
      artifactId: 'image-two',
      id: 'img-frame-2',
      type: 'image',
      mediaUrl: '/files/img-frame-2/original.jpg',
      thumbnailUrl: null,
      width: 320,
      height: 240,
      duration: 30,
      audioInfo: null,
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: imageCell,
      cells: [imageCell],
      edges: [],
      asset: currentAsset,
      versionAssets: [
        {
          ...currentAsset,
          artifactId: 'image-one',
          id: 'img-frame-1',
          mediaUrl: '/files/img-frame-1/original.jpg',
        },
        currentAsset,
      ],
      status: 'completed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('aria-label="Image versions"')
    expect(html).toContain('aria-label="Image version"')
    expect(html).toContain('Version 1 of 2')
    expect(html).toContain('Version 2 of 2 · current')
    expect(html).toContain('value="image-two" selected=""')
    expect(html).toContain('/files/img-frame-2/original.jpg')
    expect(html).toContain('<span>320×240</span>')
    expect(html).not.toContain('aria-label="Duration 0:30"')
  })

  it('shows versioned normalized shots for Analysis outputs', () => {
    const analysisCell: NotebookCell = {
      ...cell,
      type: 'analysis',
      label: 'analysis-source',
      inputs: {
        analysisRole: 'result',
        producerCellId: '01900000-0000-7000-8000-000000000010',
        outputVersionArtifactIds: ['analysis-one', 'analysis-two'],
      },
      outputArtifactId: 'analysis-two',
    }
    const currentAsset = {
      artifactId: 'analysis-two',
      id: 'analysis-source-2',
      type: 'script',
      mediaUrl: null,
      thumbnailUrl: null,
      width: null,
      height: null,
      duration: 16,
      audioInfo: null,
      analysisInfo: {
        sourceDurationSeconds: 16,
        outputJson: {
          version: 3,
          request: {
            provider: 'openai',
            model: 'gpt-5.6-sol',
            mode: 'live',
          },
          raw: {
            shots: [],
          },
        },
        outputUrl: '/files/book/analysis-source-2/analysis.json',
        llmExchanges: [{
          provider: 'openai',
          model: 'gpt-5.6-sol',
          responseFormat: {
            name: 'notebook_shot_labels',
            strict: true,
            type: 'json_schema',
          },
          stage: 'notebook_shot_labels',
        }],
        shots: [
          {
            ordinal: 2,
            label: 'Second shot',
            startSeconds: 8,
            endSeconds: 16,
            durationSeconds: 8,
          },
          {
            ordinal: 1,
            label: 'Opening shot',
            startSeconds: 0,
            endSeconds: 8,
            durationSeconds: 8,
          },
        ],
      },
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: analysisCell,
      cells: [analysisCell],
      edges: [],
      asset: currentAsset,
      versionAssets: [
        {
          ...currentAsset,
          artifactId: 'analysis-one',
          id: 'analysis-source-1',
        },
        currentAsset,
      ],
      status: 'completed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('aria-label="Analysis versions"')
    expect(html).toContain('aria-label="Analysis version"')
    expect(html).toContain('Version 2 of 2 · current')
    expect(html).not.toContain('inspector-analysis-summary')
    expect(html).not.toContain('inspector-media-field-label">ANALYSIS')
    expect(html).toContain('aria-label="LLM exchanges"')
    expect(html).toContain('<code>1 call</code>')
    expect(html).toContain('<strong>shot labels</strong>')
    expect(html).toContain('<dt>Provider</dt><dd>openai</dd>')
    expect(html).toContain('<dt>Model</dt><dd>gpt-5.6-sol</dd>')
    expect(html).toContain('<dt>Response format</dt>')
    expect(html).toContain('Strict JSON schema')
    expect(html).toContain('<code>notebook_shot_labels</code>')
    expect(html).toContain('<span>LLM input</span>')
    expect(html).toContain('<span>LLM response</span>')
    expect(html).not.toContain('legacy')
    expect(html).not.toContain('resp-analysis')
    expect(html.indexOf('Opening shot')).toBeLessThan(
      html.indexOf('Second shot'),
    )
    expect(html).not.toContain('RichJson')
    expect(html).not.toContain('Restore')
    expect(html).not.toContain('inspector-input-source-label')
    expect(html).toContain('aria-label="result input"')
    expect(html).toContain(
      'class="inspector-cell-actions inspector-compact-actions" aria-label="Cell cleanup actions"',
    )
    expect(html).toContain('Delete cell')
  })

  it('keeps inputs visible beneath a compact pending preview', () => {
    const pendingCell: NotebookCell = {
      ...cell,
      outputArtifactId: undefined,
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: pendingCell,
      cells: [pendingCell],
      edges: [],
      asset: undefined,
      status: 'pending',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('Output pending')
    expect(html.indexOf('Output pending')).toBeLessThan(
      html.indexOf('<h3>Inputs</h3>'),
    )
    expect(html).toContain('inspector-delete-cell-button')
  })

  it('shows passive cell deletion progress', () => {
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell,
      cells: [cell],
      edges: [],
      asset: undefined,
      status: 'completed',
      error: null,
      busy: true,
      deleting: true,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Deleting…')
    expect(html).toContain('inspector-delete-cell-button')
  })

  it('renders action cells with one save-and-run control', () => {
    const splitCell: NotebookCell = {
      ...cell,
      type: 'split_video',
      label: 'split-video-02',
      operation: 'split_range',
      provider: 'local',
      tool: 'ffmpeg',
      inputs: {
        startSeconds: 15,
        endSeconds: 30,
      },
    }
    const videoSource: NotebookCell = {
      ...cell,
      id: '01900000-0000-7000-8000-000000000004',
      label: 'vid-continuous-source',
      slot: { row: 0, column: 0 },
    }
    const analysisSource: NotebookCell = {
      ...cell,
      id: '01900000-0000-7000-8000-000000000005',
      type: 'analysis',
      label: 'analysis-splitter',
      slot: { row: 0, column: 1 },
      outputArtifactId: '01900000-0000-7000-8000-000000000006',
    }
    const edges: NotebookEdge[] = [
      {
        id: '01900000-0000-7000-8000-000000000007',
        source: videoSource.id,
        target: splitCell.id,
        targetInput: 'video',
      },
      {
        id: '01900000-0000-7000-8000-000000000008',
        source: analysisSource.id,
        target: splitCell.id,
        targetInput: 'analysis',
      },
    ]
    const videoSourceAsset = {
      artifactId: videoSource.outputArtifactId!,
      id: videoSource.outputArtifactId!,
      type: 'video',
      mediaUrl: '/files/vid-continuous-source/original.mp4',
      thumbnailUrl: '/files/vid-continuous-source/thumb.jpg',
      width: 1920,
      height: 1080,
      duration: 30,
      audioInfo: null,
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: splitCell,
      cells: [splitCell, videoSource, analysisSource],
      edges,
      asset: undefined,
      cellAssets: new Map([[videoSource.id, videoSourceAsset]]),
      status: 'completed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('inspector-executable-body')
    expect(html).toContain('class="inspector-cell-form"')
    expect(html).not.toContain('class="inspector-save-button"')
    expect(html).not.toContain('Save changes')
    expect(html).not.toContain('Unsaved changes')
    expect(html).not.toContain('aria-label="Action type"')
    expect(html).not.toContain('Cell type is fixed')
    expect(html).toContain('<h3>Inputs</h3>')
    expect(html).not.toContain('Select the upstream cell that supplies each input.')
    expect(html).not.toContain(
      'Changing a source clears this preview until its producer is rerun.',
    )
    expect(html).not.toContain('inspector-input-source-label')
    expect(html).toContain('aria-label="video input"')
    expect(html).toContain('aria-label="analysis input"')
    expect(html).toContain('role="listbox" aria-label="video input options"')
    expect(html).toContain('role="option" aria-selected="true"')
    expect(html).toContain('<strong>@a1</strong>')
    expect(html).toContain('<strong>@a2</strong>')
    expect(html).toContain('/files/vid-continuous-source/thumb.jpg')
    expect(html).toContain('inspector-source-picker-chevron')
    expect(html).not.toContain('placeholder="Provider"')
    expect(html).not.toContain('placeholder="Model"')
    expect(html).not.toContain('placeholder="Operation"')
    expect(html).not.toContain('placeholder="Tool"')
    expect(html).toContain('Start seconds')
    expect(html).toContain('value="15"')
    expect(html).toContain('End seconds')
    expect(html).toContain('value="30"')
    expect(html).toContain('Split again')
    expect(html).toContain('Delete cell')
    expect(html.indexOf('Split again')).toBeLessThan(html.indexOf('Delete cell'))
    expect(html).not.toContain('completed')
    expect(html).not.toContain('inspector-run-error')
  })

  it('shows the persisted failure message for an action cell', () => {
    const splitCell: NotebookCell = {
      ...cell,
      type: 'split_video',
      label: 'split-video-02',
      operation: 'split_range',
      provider: 'local',
      tool: 'ffmpeg',
      inputs: {
        startSeconds: 15,
        endSeconds: 30,
      },
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: splitCell,
      cells: [splitCell],
      edges: [],
      asset: undefined,
      status: 'error',
      error: 'ffmpeg exited with code 1\nEnd time exceeds the source duration',
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('class="inspector-run-error"')
    expect(html).toContain('role="alert"')
    expect(html).toContain('aria-label="Cell run error"')
    expect(html).toContain('Run failed')
    expect(html).toMatch(
      /aria-label="Copy run error"[^>]*title="Copy run error"[^>]*><span[^>]*>Copy<\/span><\/button>/,
    )
    expect(html).toContain('ffmpeg exited with code 1')
    expect(html).toContain('End time exceeds the source duration')
    expect(html.indexOf('Start seconds')).toBeLessThan(html.indexOf('Run failed'))
    expect(html.indexOf('Run failed')).toBeLessThan(html.indexOf('Delete cell'))
  })

  it('keeps Analyze inputs concise and gives its prompt a copy action', () => {
    const analyzeCell: NotebookCell = {
      ...cell,
      type: 'analyze',
      label: 'analyze-splitter',
      prompt: 'Split the source into narrative shots.',
      provider: 'openai',
      model: 'gpt-5.6-sol',
      operation: 'analyze_source',
      tool: 'openai_responses_analysis',
      outputArtifactId: undefined,
    }
    const sourceCell: NotebookCell = {
      ...cell,
      id: '01900000-0000-7000-8000-000000000010',
      label: 'vid-source',
    }
    const edges: NotebookEdge[] = [{
      id: '01900000-0000-7000-8000-000000000011',
      source: sourceCell.id,
      target: analyzeCell.id,
      targetInput: 'source',
    }]
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: analyzeCell,
      cells: [analyzeCell, sourceCell],
      edges,
      asset: undefined,
      status: 'pending',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('<h3>Inputs</h3>')
    expect(html).not.toContain('inspector-input-source-label')
    expect(html).toContain('aria-label="source input"')
    expect(html).not.toContain('Select the upstream cell that supplies each input.')
    expect(html).not.toContain('Changing a source clears this preview until its producer is rerun.')
    expect(html).toContain('<section class="inspector-prompt-field">')
    expect(html).toContain('<header class="inspector-prompt-header"><h3>Prompt</h3>')
    expect(html).toContain('aria-label="Copy prompt"')
    expect(html).toContain('title="Copy prompt"')
    expect(html).toContain('aria-label="Prompt"')
    expect(html).toContain('class="inspector-prompt-textarea"')
    expect(html).toContain('Split the source into narrative shots.')
    expect(html).toContain('Analyze')
  })

  it('configures Extract Frame with first, time, and last modes', () => {
    const extractFrameCell: NotebookCell = {
      ...cell,
      type: 'extract_frame',
      label: 'extract-frame-source',
      provider: 'local',
      operation: 'extract_frame',
      tool: 'ffmpeg',
      outputArtifactId: undefined,
      inputs: {
        frameMode: 'time',
        timestampSeconds: 1.25,
      },
    }
    const sourceCell: NotebookCell = {
      ...cell,
      id: '01900000-0000-7000-8000-000000000010',
      label: 'vid-source',
    }
    const edges: NotebookEdge[] = [{
      id: '01900000-0000-7000-8000-000000000011',
      source: sourceCell.id,
      target: extractFrameCell.id,
      targetInput: 'video',
    }]
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: extractFrameCell,
      cells: [extractFrameCell, sourceCell],
      edges,
      asset: undefined,
      status: 'pending',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).not.toContain('inspector-input-source-label')
    expect(html).toContain('aria-label="video input"')
    expect(html).toContain('<option value="first">First</option>')
    expect(html).toContain('<option value="time" selected="">Time</option>')
    expect(html).toContain('<option value="last">Last</option>')
    expect(html).toContain('Timestamp seconds')
    expect(html).toContain('value="1.25"')
    expect(html).toContain('Extract')
    expect(html).not.toContain('Audio')
  })

  it('persists dirty action fields before running', async () => {
    const calls: string[] = []
    const result = await persistAndRunNotebookCell({
      cellId: 'split-cell',
      dirty: true,
      valid: true,
      patch: {
        inputs: {
          startSeconds: 15,
          endSeconds: 30,
        },
      },
      onUpdate: async () => {
        calls.push('update')
        return true
      },
      onRun: async () => {
        calls.push('run')
      },
    })

    expect(result).toBe(true)
    expect(calls).toEqual(['update', 'run'])
  })

  it('marks a cell queued only after its run is accepted', async () => {
    const calls: string[] = []

    await startNotebookCellRun({
      start: async () => {
        calls.push('start')
        return { job_id: 'run-notebook-cell' }
      },
      onAccepted: () => {
        calls.push('queued')
      },
    })

    expect(calls).toEqual(['start', 'queued'])
  })

  it('does not mark a cell queued when its run is rejected', async () => {
    const calls: string[] = []

    await expect(startNotebookCellRun({
      start: async () => {
        calls.push('start')
        throw new Error('queue rejected')
      },
      onAccepted: () => {
        calls.push('queued')
      },
    })).rejects.toThrow('queue rejected')

    expect(calls).toEqual(['start'])
  })

  it('does not run an action when validation or persistence fails', async () => {
    const calls: string[] = []
    const invalid = await persistAndRunNotebookCell({
      cellId: 'split-cell',
      dirty: true,
      valid: false,
      patch: {},
      onUpdate: async () => {
        calls.push('invalid-update')
      },
      onRun: async () => {
        calls.push('invalid-run')
      },
    })
    const failedSave = await persistAndRunNotebookCell({
      cellId: 'split-cell',
      dirty: true,
      valid: true,
      patch: {},
      onUpdate: async () => {
        calls.push('failed-update')
        return false
      },
      onRun: async () => {
        calls.push('failed-run')
      },
    })

    expect(invalid).toBe(false)
    expect(failedSave).toBe(false)
    expect(calls).toEqual(['failed-update'])
  })

  it('renders fullscreen video with playback and close controls only', () => {
    const html = renderToStaticMarkup(createElement(NotebookMediaFullscreen, {
      asset: {
        artifactId: cell.outputArtifactId!,
        id: 'vid-source',
        type: 'video',
        mediaUrl: '/files/vid-source/original.mp4',
        thumbnailUrl: '/files/vid-source/original.jpg',
        width: 1920,
        height: 1080,
        duration: 30,
        audioInfo: null,
      },
      address: notebookGridAddress(cell.slot),
      onClose: () => undefined,
    }))

    expect(html).toContain('<video')
    expect(html).toContain('controls=""')
    expect(html).toContain('autoPlay=""')
    expect(html).toContain('aria-label="Close fullscreen preview"')
    expect(html).not.toContain('Media cell inspector')
    expect(html).not.toContain('Dolt source')
    expect(html).not.toContain('Delete')
    expect(html).not.toContain('People &amp; objects')
    expect(html).not.toContain('Edit selected')
  })

  it('renders an accessible subject workspace with deterministic overlays', () => {
    const subjectMap = asImageSubjectMap({
      status: 'ready',
      artifact_id: 'image-artifact',
      object_hash: 'sha256:image',
      width: 1200,
      height: 800,
      base_url: '/files/book/image-artifact/base.png',
      subjects: [{
        id: 'person-1',
        label: 'Person',
        description: 'Person in the foreground',
        normalized_box: { x: 0.2, y: 0.1, width: 0.35, height: 0.8 },
        layer_url: '/files/book/image-artifact/person.png',
        thumbnail_url: '/files/book/image-artifact/person-thumb.png',
        z_index: 1,
        capabilities: { remove: true, exact_edit: false },
      }],
    })
    const html = renderToStaticMarkup(createElement(NotebookMediaFullscreen, {
      asset: {
        artifactId: 'image-artifact',
        id: 'image-source',
        objectHash: 'sha256:image',
        type: 'image',
        mediaUrl: '/files/book/image-artifact/original.png',
        thumbnailUrl: null,
        width: 1200,
        height: 800,
        duration: null,
        audioInfo: null,
      },
      address: 'c3',
      subjectMap,
      onAnalyzeSubjects: async () => undefined,
      onEditSubjects: async () => true,
      onClose: () => undefined,
    }))

    expect(subjectMap.subjects[0]?.box).toEqual({
      x: 0.2,
      y: 0.1,
      width: 0.35,
      height: 0.8,
    })
    expect(subjectMap.subjects[0]?.color).toMatch(/^#[0-9a-f]{6}$/i)
    expect(html).toContain('aria-label="Subject editor"')
    expect(html).toContain('Image with detected subject overlays')
    expect(html).toContain('/files/book/image-artifact/person.png')
    expect(html).toContain('Person in the foreground')
    expect(html).toContain('Preview removal')
    expect(html).toContain('Remove')
    expect(html).toContain('Edit selected')
    expect(html).not.toContain('autoPlay')
  })

  it('renders a failed subject analysis with its error and retry action', () => {
    const html = renderToStaticMarkup(createElement(NotebookMediaFullscreen, {
      asset: {
        artifactId: 'image-artifact',
        id: 'image-source',
        objectHash: 'sha256:image',
        type: 'image',
        mediaUrl: '/files/book/image-artifact/original.png',
        thumbnailUrl: null,
        width: 1200,
        height: 800,
        duration: null,
        audioInfo: null,
      },
      address: 'c3',
      subjectMap: asImageSubjectMap({
        status: 'failed',
        artifact_id: 'image-artifact',
        object_hash: 'sha256:image',
        error: 'Seedream decomposition timed out before returning layers.',
      }),
      onAnalyzeSubjects: async () => undefined,
      onEditSubjects: async () => true,
      onClose: () => undefined,
    }))

    expect(html).toContain('Analysis did not finish')
    expect(html).toContain('Seedream decomposition timed out before returning layers.')
    expect(html).toContain('>Retry</button>')
    expect(html).not.toContain('Finding people and objects')
    expect(html).not.toContain('Analyzing…')
    expect(html).not.toContain('lucide-loader-circle')
  })

  it('projects every persisted cells-table column with raw null and JSON values', () => {
    const rows = doltCellRows(
      '01900000-0000-7000-8000-000000000003',
      cell,
    )

    expect(rows.map((row) => row.column)).toEqual([
      'notebook_id',
      'cell_id',
      'type',
      'label',
      'grid_row',
      'grid_column',
      'output_entity_id',
      'prompt',
      'provider',
      'model',
      'operation',
      'tool',
      'inputs_json',
      'output_artifact_id',
    ])
    expect(rows.find((row) => row.column === 'prompt')?.value).toBeNull()
    expect(rows.find((row) => row.column === 'inputs_json')?.value).toBe(
      '{"operation":"download_video","selectedRangeSeconds":[1490,1550]}',
    )
  })

  it('classifies only valid _json columns as nested JSON', () => {
    expect(doltCellDisplayValue({
      column: 'inputs_json',
      type: 'TEXT',
      value: '{"operation":"download_video","selectedRangeSeconds":[1490,1550]}',
    })).toEqual({
      kind: 'json',
      value: {
        operation: 'download_video',
        selectedRangeSeconds: [1490, 1550],
      },
    })
    expect(doltCellDisplayValue({
      column: 'inputs_json',
      type: 'TEXT',
      value: '{malformed',
    })).toEqual({
      kind: 'raw',
      value: '{malformed',
    })
    expect(doltCellDisplayValue({
      column: 'label',
      type: 'TEXT',
      value: '{"raw":"scalar"}',
    })).toEqual({
      kind: 'raw',
      value: '{"raw":"scalar"}',
    })
    expect(doltCellDisplayValue({
      column: 'prompt',
      type: 'TEXT',
      value: null,
    })).toEqual({
      kind: 'null',
    })
  })

  it('shares the Dolt table renderer with non-passive cells', () => {
    const promptCell: NotebookCell = {
      ...cell,
      type: 'prompt',
      prompt: undefined,
      outputArtifactId: undefined,
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: promptCell,
      cells: [promptCell],
      edges: [],
      asset: undefined,
      status: 'completed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: true,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('aria-label="Raw Dolt cells row"')
    expect(html).toContain('<th>Column</th><th>Type</th><th>Raw value</th>')
    expect(html).toContain('class="inspector-dolt-json-meta"')
    expect(html).toContain('<code class="dolt-json-kind">JSON</code>')
    expect(html).toContain('class="inspector-dolt-json-value"')
    expect(html).toContain('<td colSpan="3">')
    expect(html).toContain('aria-label="inputs_json JSON"')
    expect(html).toContain('class="json-key"')
    expect(html).toContain('<code class="dolt-null">NULL</code>')
    expect(html).not.toContain('inspector-delete-cell-button')
  })

  it('keeps non-passive editing controls out of the source view', () => {
    const promptCell: NotebookCell = {
      ...cell,
      type: 'prompt',
      prompt: undefined,
      outputArtifactId: undefined,
    }
    const html = renderToStaticMarkup(createElement(NotebookCellInspector, {
      notebookId: '01900000-0000-7000-8000-000000000003',
      cell: promptCell,
      cells: [promptCell],
      edges: [],
      asset: undefined,
      status: 'completed',
      error: null,
      busy: false,
      deleting: false,
      sourceVisible: false,
      onUpdate: async () => undefined,
      onSetInput: async () => undefined,
      onRun: async () => undefined,
      onDelete: async () => undefined,
      onOpenFullscreen: () => undefined,
    }))

    expect(html).toContain('inspector-delete-cell-button')
    expect(html).toContain('Delete cell')
    expect(html).toContain('class="inspector-save-button" disabled=""')
    expect(html).toContain(
      'class="inspector-cell-actions inspector-compact-actions" aria-label="Cell cleanup actions"',
    )
    expect(html).not.toContain('Dolt source')
  })
})
