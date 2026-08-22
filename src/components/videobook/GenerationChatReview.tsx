import { useState } from 'react'
import { Check, CircleAlert, Plus, X } from 'lucide-react'
import type {
  GenerationControlValue,
  GenerationInputMode,
  NotebookGenerationAction,
} from '@/videobook/notebook-generation-actions'
import { GenerationControlField } from './GenerationControlField'
import {
  notebookChatGenerationSettings,
  type NotebookChatGenerationDraft,
} from '@/videobook/notebook-chat-generation'
import {
  MediaLibraryAssetPreview,
  type MediaLibraryPreviewAsset,
} from './MediaLibraryAssetPreview'
import { VoiceOptionList } from './SpeakCommandPreview'
import { useVoicePreviewPlayer } from '@/videobook/voice-preview-player'
import { persistSpeakVoiceId } from '@/videobook/speak-preview'
import type { ElevenLabsVoicesState } from '@/videobook/use-elevenlabs-voices'
import { recordValue } from '@/videobook/value-decoders'
import { providerPayloadPreviewMentions } from '@/videobook/provider-payload-preview'

export type GenerationReviewSource = {
  cellId: string
  address: string
  type: string
  asset: MediaLibraryPreviewAsset | null
}

type GenerationChatReviewProps = {
  actions: readonly NotebookGenerationAction[]
  applyFormId: string
  busy: boolean
  draft: NotebookChatGenerationDraft
  modes: readonly GenerationInputMode[]
  preview: unknown | null
  previewError: string | null
  previewLoading: boolean
  previewStale: boolean
  sources: readonly GenerationReviewSource[]
  sourceOptions: readonly GenerationReviewSource[]
  summary: string
  voiceCatalog?: ElevenLabsVoicesState
  onActionChange: (actionId: string) => void
  onAddSource: (cellId: string) => void
  onCancel: () => void
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

export function GenerationChatReview({
  actions,
  applyFormId,
  busy,
  draft,
  modes,
  preview,
  previewError,
  previewLoading,
  previewStale,
  sources,
  sourceOptions,
  summary,
  voiceCatalog,
  onActionChange,
  onAddSource,
  onCancel,
  onModeChange,
  onPromptChange,
  onRefreshPreview,
  onRemoveSource,
  onSelectSource,
  onSettingChange,
}: GenerationChatReviewProps) {
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
  const estimate = recordValue(previewValue?.estimate)
  const estimateUsd = typeof estimate?.usd === 'number' ? estimate.usd : null
  const estimateCurrency = typeof estimate?.currency === 'string'
    ? estimate.currency
    : 'USD'
  const estimateWarnings = Array.isArray(estimate?.warnings)
    ? estimate.warnings.filter((warning): warning is string =>
        typeof warning === 'string')
    : []
  const estimateUnknown = estimateWarnings.some((warning) =>
    /not found|unavailable|no cost adapter|unknown/iu.test(warning))
  const previewMentions = providerPayloadPreviewMentions(preview)
  const promptLeaks = previewStale ? [] : previewMentions.promptLeaks
  const previewBlocksApply = !previewStale
    && (previewLoading || previewError !== null || promptLeaks.length > 0)
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
    <aside
      className="command-plan-drawer generation-chat-review"
      aria-label="Generation action review"
      aria-keyshortcuts="Escape"
    >
      <header>
        <div className="command-plan-heading">
          <span className="section-label">GENERATION · CHAT</span>
          <h2>{summary}</h2>
        </div>
        <div className="command-plan-primary-actions">
          <button
            type="submit"
            form={applyFormId}
            className="command-plan-apply"
            disabled={busy || !draft.cell.prompt?.trim() || previewBlocksApply}
          >
            <Check size={14} />Apply
          </button>
          <button type="button" disabled={busy} onClick={onCancel}>
            <X size={14} />Cancel
          </button>
        </div>
      </header>

      <div className="generation-review-editor">
        <section className="generation-review-section generation-review-input-section">
          <span className="generation-review-label">Inputs</span>
          <div className="generation-review-sources">
            {sources.map((source) => (
              <div className="generation-review-source-wrap" key={source.cellId}>
                <button
                  type="button"
                  className="generation-review-source"
                  disabled={busy}
                  onClick={() => onSelectSource(source.cellId)}
                  title={`Select @${source.address} on the board`}
                >
                  <span className="generation-review-source-badge">Input</span>
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
                <button
                  type="button"
                  className="generation-review-source"
                  key={option.cellId}
                  disabled={busy}
                  onClick={() => onAddSource(option.cellId)}
                  title={`Add @${option.address} as input`}
                >
                  <span className="generation-review-source-badge">Add</span>
                  <span className="generation-review-source-preview">
                    <MediaLibraryAssetPreview
                      asset={option.asset ?? {
                        type: option.type,
                        mediaUrl: null,
                        thumbnailUrl: null,
                        duration: null,
                      }}
                      eager
                    />
                  </span>
                  <span className="generation-review-source-copy">
                    <strong>@{option.address}</strong>
                    <small>{option.type.replaceAll('_', ' ')}</small>
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>

        <section className="generation-review-section generation-review-prompt-section">
          <label>
            <span className="generation-review-label">Prompt</span>
            <textarea
              rows={5}
              value={draft.cell.prompt ?? ''}
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

        <section className="generation-review-section generation-review-model-section">
          <label>
            <span className="generation-review-label">Model</span>
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
              <span className="generation-review-label">Type</span>
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
            <div>
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
          <section className="generation-review-section generation-review-voice-section">
            <span className="generation-review-label">Voice</span>
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

        <section className="generation-review-section generation-review-settings-section">
          <span className="generation-review-label">Settings</span>
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

        <section className="generation-review-section generation-review-estimate-section">
          <span className="generation-review-label">Estimate</span>
          <strong>
            {previewLoading
              ? '…'
              : estimateUsd !== null && !estimateUnknown
                ? `$${estimateUsd.toFixed(estimateUsd < 0.01 ? 4 : 2)}`
                : '—'}
          </strong>
          <span>{estimateCurrency}</span>
          <small>
            {previewLoading
              ? 'Estimated provider cost'
              : previewError || estimateUnknown || estimateUsd === null
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
            {previewStale ? 'Refresh estimate' : 'Refresh'}
          </button>
        </section>
      </div>
    </aside>
  )
}
