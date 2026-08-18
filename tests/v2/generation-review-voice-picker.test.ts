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
    summary: 'Generate audio as @a1',
    ...(catalog ? { voiceCatalog: catalog } : {}),
    onActionChange: () => undefined,
    onCancel: () => undefined,
    onModeChange: () => undefined,
    onPromptChange: () => undefined,
    onRefreshPreview: () => undefined,
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
