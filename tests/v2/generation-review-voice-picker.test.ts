import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { GenerationChatReview } from '../../src/components/videobook/GenerationChatReview'
import type { NotebookChatGenerationDraft } from '../../src/videobook/notebook-chat-generation'
import type { NotebookGenerationAction } from '../../src/videobook/notebook-generation-actions'
import type { ElevenLabsVoicesState } from '../../src/videobook/use-elevenlabs-voices'

const ttsAction: NotebookGenerationAction = {
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
  inputContract: {
    modes: [{ id: 'text_to_audio', slots: [], requiredGroups: [] }],
  },
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
}

function speechDraft(): NotebookChatGenerationDraft {
  return {
    action: ttsAction,
    cell: {
      id: '00000000-0000-7000-8000-000000000001',
      type: 'generate_audio',
      slot: { row: 0, column: 0 },
      prompt: 'welcome back everyone',
      provider: ttsAction.provider,
      model: ttsAction.model,
      operation: ttsAction.operation,
      tool: ttsAction.tool,
      inputs: { generationSettings: { voice_id: 'voice-b' } },
    },
    connections: [],
    sourceCellIds: [],
    sourceAddresses: [],
  }
}

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
    { voiceId: 'voice-c', name: 'Cora', source: 'generic' },
  ],
  status: 'fallback',
  warning: 'ELEVENLABS_API_KEY is not configured; showing fallback voices.',
  loading: false,
  error: null,
  ensureLoaded: async () => null,
  refresh: async () => null,
}

function renderReview(
  draft: NotebookChatGenerationDraft,
  catalog?: ElevenLabsVoicesState,
  preview: unknown = null,
  previewStale = false,
): string {
  return renderToStaticMarkup(createElement(GenerationChatReview, {
    actions: [ttsAction],
    applyFormId: 'apply-form',
    busy: false,
    draft,
    modes: ttsAction.inputContract.modes,
    preview,
    previewError: null,
    previewLoading: false,
    previewStale,
    sources: [],
    sourceOptions: [],
    summary: 'Generate audio as @a1',
    ...(catalog ? { voiceCatalog: catalog } : {}),
    onActionChange: () => undefined,
    onAddSource: () => undefined,
    onCancel: () => undefined,
    onModeChange: () => undefined,
    onPromptChange: () => undefined,
    onRefreshPreview: () => undefined,
    onRemoveSource: () => undefined,
    onSelectSource: () => undefined,
    onSettingChange: () => undefined,
  }))
}

describe('GenerationChatReview voice picker', () => {
  it('renders the full voice catalog with the draft voice selected', () => {
    const html = renderReview(speechDraft(), voiceCatalog)

    expect(html).toContain('data-testid="generation-review-voices"')
    expect(html).toContain('Ada')
    expect(html).toContain('Bella')
    expect(html).toContain('Cora')
    expect(html).toContain('custom · cloned')
    expect(html).toContain('Preview')
    expect(html).toContain('speak-preview-voice selected')
    expect(html).toContain('data-voice-id="voice-b"')
    expect(html).toContain('ELEVENLABS_API_KEY is not configured')
    expect(html).toContain('Refresh voices')
  })

  it('hides the raw voice_id text control when the picker is shown', () => {
    const html = renderReview(speechDraft(), voiceCatalog)

    expect(html).not.toContain('aria-label="Voice id"')
    expect(html).toContain('aria-label="Asset name"')
  })

  it('falls back to the plain voice_id control without a catalog', () => {
    const html = renderReview(speechDraft())

    expect(html).not.toContain('data-testid="generation-review-voices"')
    expect(html).toContain('aria-label="Voice id"')
  })

  it('renders setting fields as direct children of the shared grid', () => {
    const html = renderReview(speechDraft())

    expect(html).toContain('class="generation-review-settings"><label')
  })

  it('offers event-driven loading when the catalog is empty', () => {
    const html = renderReview(speechDraft(), {
      ...voiceCatalog,
      voices: [],
      error: 'Voice request failed',
    })

    expect(html).not.toContain('data-testid="generation-review-voices"')
    expect(html).toContain('aria-label="Voice id"')
    expect(html).toContain('Voice request failed')
    expect(html).toContain('Retry voices')
  })

  it('shows broken references and disables Apply for a current preview', () => {
    const html = renderReview(speechDraft(), undefined, {
      mentions: {
        prompt_leaks: [{
          token: '@e2',
          code: 'no_output',
          message: '@e2 does not have media output yet',
        }],
      },
    })

    expect(html).toContain('role="alert"')
    expect(html).toContain('<code>@e2</code>')
    expect(html).toContain('@e2 does not have media output yet')
    expect(html).toContain('class="command-plan-apply" disabled=""')
  })

  it('allows a stale preview to be revalidated on Apply', () => {
    const html = renderReview(speechDraft(), undefined, {
      mentions: {
        prompt_leaks: [{
          token: '@e2',
          code: 'no_output',
          message: '@e2 does not have media output yet',
        }],
      },
    }, true)

    expect(html).not.toContain('role="alert"')
    expect(html).not.toContain('class="command-plan-apply" disabled=""')
  })
})

describe('GenerationChatReview input editing', () => {
  const imageSource = {
    cellId: '00000000-0000-7000-8000-0000000000a2',
    address: 'a2',
    type: 'image',
    asset: null,
  }
  const imageOption = {
    cellId: '00000000-0000-7000-8000-0000000000a3',
    address: 'a3',
    type: 'image',
    asset: null,
  }

  function renderInputs(
    sources: { cellId: string; address: string; type: string; asset: null }[],
    sourceOptions: { cellId: string; address: string; type: string; asset: null }[],
  ): string {
    return renderToStaticMarkup(createElement(GenerationChatReview, {
      actions: [ttsAction],
      applyFormId: 'apply-form',
      busy: false,
      draft: speechDraft(),
      modes: ttsAction.inputContract.modes,
      preview: null,
      previewError: null,
      previewLoading: false,
      previewStale: false,
      sources,
      sourceOptions,
      summary: 'Generate audio as @a1',
      onActionChange: () => undefined,
      onAddSource: () => undefined,
      onCancel: () => undefined,
      onModeChange: () => undefined,
      onPromptChange: () => undefined,
      onRefreshPreview: () => undefined,
      onRemoveSource: () => undefined,
      onSelectSource: () => undefined,
      onSettingChange: () => undefined,
    }))
  }

  it('offers a remove control for each connected input', () => {
    const html = renderInputs([imageSource], [])

    expect(html).toContain('aria-label="Remove @a2 input"')
    expect(html).toContain('Select @a2 on the board')
    expect(html).not.toContain('Add input')
  })

  it('offers an add control while candidate cells remain', () => {
    const html = renderInputs([imageSource], [imageOption])

    expect(html).toContain('aria-label="Remove @a2 input"')
    expect(html).toContain('Add input')
    expect(html).not.toContain('Available input cells')
  })

  it('offers the add control from the prompt-only empty state', () => {
    const html = renderInputs([], [imageOption])

    expect(html).toContain('Prompt only')
    expect(html).toContain('Add input')
  })
})
