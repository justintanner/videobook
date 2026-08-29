import { useState } from 'react'
import { CircleAlert, Plus, RefreshCw, X } from 'lucide-react'
import type {
  GenerationControlValue,
  GenerationInputMode,
  NotebookGenerationAction,
} from '@/videobook/notebook-generation-actions'
import { GenerationControlField } from '@/components/videobook/GenerationControlField'
import {
  notebookChatGenerationSettings,
  type NotebookChatGenerationDraft,
} from '@/videobook/notebook-chat-generation'
import {
  MediaLibraryAssetPreview,
  type MediaLibraryPreviewAsset,
} from '@/components/videobook/MediaLibraryAssetPreview'
import { VoiceOptionList } from '@/components/videobook/SpeakCommandPreview'
import { useVoicePreviewPlayer } from '@/videobook/voice-preview-player'
import { persistSpeakVoiceId } from '@/videobook/speak-preview'
import type { ElevenLabsVoicesState } from '@/videobook/use-elevenlabs-voices'
import { recordValue } from '@/videobook/value-decoders'
import {
  generationEstimate,
  providerPayloadPreviewMentions,
} from '@/videobook/provider-payload-preview'

export type GenerationReviewSource = {
  cellId: string
  address: string
  type: string
  asset: MediaLibraryPreviewAsset | null
}

type GenerationBodyProps = {
  actions: readonly NotebookGenerationAction[]
  busy: boolean
  draft: NotebookChatGenerationDraft
  modes: readonly GenerationInputMode[]
  preview: unknown | null
  previewError: string | null
  previewLoading: boolean
  previewStale: boolean
  sources: readonly GenerationReviewSource[]
  sourceOptions: readonly GenerationReviewSource[]
  voiceCatalog?: ElevenLabsVoicesState
  onActionChange: (actionId: string) => void
  onAddSource: (cellId: string) => void
  onModeChange: (modeId: string) => void
  onPromptChange: (prompt: string) => void
  onRefreshPreview: () => void
  onRemoveSource: (cellId: string) => void
  onSelectSource: (cellId: string) => void
  onSettingChange: (
    name: string,
    value: GenerationControlValue | undefined,
  ) => void
}

function generationMode(draft: NotebookChatGenerationDraft): string {
  const inputs = draft.cell.inputs
  return inputs && typeof inputs.generationMode === 'string'
    ? inputs.generationMode
    : ''
}

function SourceCard({
  badge,
  busy,
  onClick,
  source,
  title,
}: {
  badge: string
  busy: boolean
  onClick: () => void
  source: GenerationReviewSource
  title: string
}) {
  return (
    <button
      type="button"
      className="generation-review-source"
      disabled={busy}
      onClick={onClick}
      title={title}
    >
      <span className="generation-review-source-badge">{badge}</span>
      <span className="generation-review-source-preview">
        <MediaLibraryAssetPreview
          asset={source.asset ?? {
            type: source.type,
            mediaUrl: null,
            thumbnailUrl: null,
            duration: null,
          }}
          eager
        />
      </span>
      <span className="generation-review-source-copy">
        <strong>@{source.address}</strong>
        <small>{source.type.replaceAll('_', ' ')}</small>
      </span>
    </button>
  )
}

export function GenerationBody({
  actions,
  busy,
  draft,
  modes,
  preview,
  previewError,
  previewLoading,
  previewStale,
  sources,
  sourceOptions,
  voiceCatalog,
  onActionChange,
  onAddSource,
  onModeChange,
  onPromptChange,
  onRefreshPreview,
  onRemoveSource,
  onSelectSource,
  onSettingChange,
}: GenerationBodyProps) {
  const [showSourcePicker, setShowSourcePicker] = useState(false)
  const settings = notebookChatGenerationSettings(draft)
  const previewPlayer = useVoicePreviewPlayer()
  const ensureVoiceCatalog = () => {
    if (!voiceCatalog) return
    void voiceCatalog.ensureLoaded().catch(() => undefined)
  }
  const refreshVoiceCatalog = () => {
    if (!voiceCatalog) return
    void voiceCatalog.refresh().catch(() => undefined)
  }
  const voiceControl = draft.cell.type === 'generate_audio'
    ? draft.action.controls.find((control) => control.name === 'voice_id')
    : undefined
  const voiceOptions = voiceControl ? voiceCatalog?.voices ?? [] : []
  const showVoicePicker = voiceOptions.length > 0
  const selectedVoiceId = typeof settings.voice_id === 'string'
    ? settings.voice_id
    : ''
  const generalControls = showVoicePicker
    ? draft.action.controls.filter((control) => control.name !== 'voice_id')
    : draft.action.controls
  const previewValue = recordValue(preview)
  const estimate = generationEstimate(preview)
  const promptLeaks = previewStale ? [] : providerPayloadPreviewMentions(preview).promptLeaks
  const previewJson = previewValue ?? {
    status: 'unresolved_draft',
    message: 'The server preview has not resolved this draft yet.',
    payload: null,
    draft: {
      tool: draft.action.tool,
      provider: draft.action.provider,
      model: draft.action.model,
      prompt: draft.cell.prompt,
      inputs: draft.cell.inputs ?? {},
    },
  }
  return (
    <div className="confirm-generation">
      <section className="confirm-section generation-review-input-section" aria-label="Inputs">
        <span className="confirm-section-label">Inputs</span>
        <div className="generation-review-sources">
          {sources.map((source) => (
            <div className="generation-review-source-wrap" key={source.cellId}>
              <SourceCard
                badge="Input"
                busy={busy}
                source={source}
                title={`Select @${source.address} on the board`}
                onClick={() => onSelectSource(source.cellId)}
              />
              <button
                type="button"
                className="generation-review-source-remove"
                disabled={busy}
                aria-label={`Remove @${source.address} input`}
                title={`Remove @${source.address} input`}
                onClick={() => onRemoveSource(source.cellId)}
              >
                <X size={11} aria-hidden="true" />
              </button>
            </div>
          ))}
          {sources.length === 0 && (
            <div className="generation-review-text-input">
              <span>Input</span>
              <strong>Prompt only</strong>
              <small>No source media attached</small>
            </div>
          )}
          {sourceOptions.length > 0 && (
            <button
              type="button"
              className="generation-review-source-add"
              disabled={busy}
              aria-expanded={showSourcePicker}
              onClick={() => setShowSourcePicker((current) => !current)}
            >
              <Plus size={14} aria-hidden="true" />
              <span>Add input</span>
            </button>
          )}
        </div>
        {showSourcePicker && sourceOptions.length > 0 && (
          <div
            className="generation-review-sources generation-review-source-options"
            aria-label="Available input cells"
          >
            {sourceOptions.map((option) => (
              <SourceCard
                key={option.cellId}
                badge="Add"
                busy={busy}
                source={option}
                title={`Add @${option.address} as input`}
                onClick={() => onAddSource(option.cellId)}
              />
            ))}
          </div>
        )}
      </section>

      <section className="confirm-section generation-review-prompt-section" aria-label="Prompt">
        <label>
          <span className="confirm-section-label">Prompt</span>
          <textarea
            rows={5}
            value={draft.cell.prompt ?? ''}
            aria-invalid={promptLeaks.length > 0}
            disabled={busy}
            onChange={(event) => onPromptChange(event.target.value)}
          />
        </label>
        {promptLeaks.length > 0 && (
          <div className="generation-review-reference-errors" role="alert">
            {promptLeaks.map((leak) => (
              <span key={`${leak.token}:${leak.code}`} title={leak.message}>
                <CircleAlert size={12} aria-hidden="true" />
                <code>{leak.token}</code>
                {leak.message}
              </span>
            ))}
          </div>
        )}
        <small>Or type <kbd>/apply your quick prompt</kbd> below.</small>
      </section>

      <section className="confirm-section generation-review-model-section" aria-label="Model">
        <label>
          <span className="confirm-section-label">Model</span>
          <select
            aria-label="Generation model"
            value={draft.action.id}
            disabled={busy || actions.length === 0}
            onChange={(event) => onActionChange(event.target.value)}
          >
            {actions.map((action) => (
              <option key={action.id} value={action.id}>
                {action.title} · {action.providerLabel}
              </option>
            ))}
          </select>
        </label>
        {modes.length > 1 && (
          <label>
            <span className="confirm-section-label">Type</span>
            <select
              aria-label="Generation type"
              value={generationMode(draft)}
              disabled={busy}
              onChange={(event) => onModeChange(event.target.value)}
            >
              {modes.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.id.replaceAll('_', ' ').toUpperCase()}
                </option>
              ))}
            </select>
          </label>
        )}
        <small>{draft.action.providerLabel} · {draft.action.model}</small>
        <details className="generation-review-json">
          <summary>
            Preview JSON
            {previewStale && <span>Needs refresh</span>}
          </summary>
          <div tabIndex={0}>
            {previewLoading ? (
              <span className="generation-review-json-status">Loading preview…</span>
            ) : previewError ? (
              <span className="generation-review-json-status generation-review-json-error">
                {previewError}
              </span>
            ) : (
              <pre>{JSON.stringify(previewJson, null, 2)}</pre>
            )}
          </div>
        </details>
      </section>

      {voiceControl && voiceCatalog && (
        <section className="confirm-section generation-review-voice-section" aria-label="Voice">
          <span className="confirm-section-label">Voice</span>
          {showVoicePicker && (
            <div
              className="generation-review-voices"
              role="listbox"
              aria-label="ElevenLabs voices"
              data-testid="generation-review-voices"
            >
              <VoiceOptionList
                voices={voiceOptions}
                selectedVoiceId={selectedVoiceId}
                playingVoiceId={previewPlayer.playingVoiceId}
                disabled={busy}
                onSelect={(voiceId) => {
                  persistSpeakVoiceId(voiceId)
                  onSettingChange('voice_id', voiceId)
                }}
                onTogglePreview={previewPlayer.toggle}
              />
            </div>
          )}
          {voiceCatalog.loading && voiceOptions.length === 0 && (
            <small>Loading voices…</small>
          )}
          {voiceCatalog.error && (
            <small role="alert">{voiceCatalog.error}</small>
          )}
          <button
            type="button"
            disabled={busy || voiceCatalog.loading}
            onClick={refreshVoiceCatalog}
          >
            {voiceCatalog.loading
              ? 'Loading voices…'
              : voiceCatalog.error
                ? 'Retry voices'
                : showVoicePicker ? 'Refresh voices' : 'Load voices'}
          </button>
          {voiceCatalog?.warning && <small>{voiceCatalog.warning}</small>}
        </section>
      )}

      <section className="confirm-section generation-review-settings-section" aria-label="Settings">
        <span className="confirm-section-label">Settings</span>
        <div className="generation-review-settings">
          {generalControls.length > 0 ? generalControls.map((control) => (
            <GenerationControlField
              key={control.name}
              control={control}
              settings={settings}
              busy={busy}
              toggleClassName="generation-review-toggle"
              onFocus={control.name === 'voice_id'
                ? ensureVoiceCatalog
                : undefined}
              onChange={(value) => onSettingChange(control.name, value)}
            />
          )) : (
            <span className="generation-review-defaults">Provider defaults</span>
          )}
        </div>
      </section>

      <section className="confirm-section generation-review-estimate-section" aria-label="Estimate">
        <span className="confirm-section-label">Estimate</span>
        <strong>
          {previewLoading
            ? '…'
            : estimate.usd !== null && !estimate.unknown
              ? `$${estimate.usd.toFixed(estimate.usd < 0.01 ? 4 : 2)}`
              : '—'}
        </strong>
        <span>{estimate.currency}</span>
        <small>
          {previewLoading
            ? 'Estimated provider cost'
            : previewError || estimate.unknown || estimate.usd === null
              ? 'Cost estimate unavailable'
              : previewStale
                ? 'Prompt changed · refresh estimate'
                : 'Estimated provider cost'}
        </small>
        <button
          type="button"
          disabled={busy || previewLoading}
          onClick={onRefreshPreview}
        >
          <RefreshCw size={10} aria-hidden="true" />
          {previewStale ? 'Refresh estimate' : 'Refresh'}
        </button>
      </section>
    </div>
  )
}
