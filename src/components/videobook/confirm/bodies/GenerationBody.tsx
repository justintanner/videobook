import { useState, type ReactNode } from 'react'
import { CircleAlert, Plus, RefreshCw, X } from 'lucide-react'
import {
  generationModeLabel,
  type GenerationControlValue,
  type GenerationInputMode,
  type NotebookGenerationAction,
} from '@/videobook/notebook-generation-actions'
import { GenerationControlField } from '@/components/videobook/GenerationControlField'
import type { ArtifactThumbAsset } from '@/components/videobook/ArtifactThumb'
import { RichJson } from '@/components/videobook/RichJson'
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
  targetInput?: string
  targetLabel?: string
  /** Prompt token naming this input ("image1"); set when the prompt names
   *  inputs by slot rather than by grid address. */
  mention?: string
  asset: (MediaLibraryPreviewAsset & ArtifactThumbAsset) | null
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
  promptEditor?: ReactNode
  inputFooter?: ReactNode
  compatibleModeIds?: ReadonlySet<string>
  sourceVisible?: boolean
  onActionChange: (actionId: string) => void
  onAddSource: (cellId: string, targetInput?: string) => void
  onModeChange: (modeId: string) => void
  onPromptChange: (prompt: string) => void
  onRefreshPreview: () => void
  onRemoveSource: (cellId: string, targetInput?: string) => void
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

function previewAssets(
  sources: readonly GenerationReviewSource[],
  preview: unknown,
): ReadonlyMap<string, ArtifactThumbAsset> {
  const assets = new Map<string, ArtifactThumbAsset>()
  for (const source of sources) {
    if (!source.asset) continue
    for (const reference of [
      source.cellId,
      `@${source.address}`,
      source.asset.artifactId,
      `@${source.asset.artifactId}`,
      source.asset.mediaUrl,
      source.asset.thumbnailUrl,
    ]) {
      if (reference) assets.set(reference, source.asset)
    }
  }
  for (const placeholder of providerPayloadPreviewMentions(preview).urlPlaceholders) {
    const asset = assets.get(placeholder.reference)
    if (asset) assets.set(placeholder.url, asset)
  }
  return assets
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
        <strong>@{source.mention ?? source.address}</strong>
        <small>
          {source.mention ? `@${source.address} · ` : ''}
          {source.targetLabel ?? source.type.replaceAll('_', ' ')}
        </small>
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
  promptEditor,
  inputFooter,
  compatibleModeIds,
  sourceVisible = false,
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
  const fieldControls = generalControls.filter((control) => control.kind !== 'boolean')
  const toggleControls = generalControls.filter((control) => control.kind === 'boolean')
  const previewValue = recordValue(preview)
  const artifactAssets = previewAssets(sources, preview)
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
    <div className="confirm-generation" data-view={sourceVisible ? 'source' : 'form'}>
      <section className="confirm-section generation-review-input-section" aria-label="Inputs">
        <span className="confirm-section-label">Inputs</span>
        <div className="generation-review-sources">
          {sources.map((source) => (
            <div className="generation-review-source-wrap" key={`${source.cellId}:${source.targetInput ?? ''}`}>
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
                onClick={() => onRemoveSource(source.cellId, source.targetInput)}
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
                key={`${option.cellId}:${option.targetInput ?? ''}`}
                badge="Add"
                busy={busy}
                source={option}
                title={`Add @${option.address} as ${option.targetLabel ?? 'input'}`}
                onClick={() => {
                  onAddSource(option.cellId, option.targetInput)
                  setShowSourcePicker(false)
                }}
              />
            ))}
          </div>
        )}
        {inputFooter}
      </section>

      <div className="confirm-section generation-review-editor" hidden={sourceVisible === true}>
        <section className="generation-review-model-section" aria-label="Model">
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
                    {generationModeLabel(mode.id)}
                    {compatibleModeIds && !compatibleModeIds.has(mode.id) ? ' · needs inputs' : ''}
                  </option>
                ))}
              </select>
            </label>
          )}
        </section>

        <section className="generation-review-prompt-section" aria-label="Prompt">
          {promptEditor ?? <label>
            <span className="confirm-section-label">Prompt</span>
            <textarea
              rows={3}
              value={draft.cell.prompt ?? ''}
              aria-invalid={promptLeaks.length > 0}
              disabled={busy}
              onChange={(event) => onPromptChange(event.target.value)}
            />
          </label>}
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
        </section>

        <section className="generation-review-settings-section" aria-label="Settings">
          <div className="generation-review-settings">
            {fieldControls.map((control) => (
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
            ))}
            {generalControls.length === 0 && (
              <span className="generation-review-defaults">Provider defaults</span>
            )}
          </div>
          {toggleControls.length > 0 && (
            <div className="generation-review-toggles">
              {toggleControls.map((control) => (
                <GenerationControlField
                  key={control.name}
                  control={control}
                  settings={settings}
                  busy={busy}
                  toggleClassName="generation-review-toggle"
                  onChange={(value) => onSettingChange(control.name, value)}
                />
              ))}
            </div>
          )}
        </section>

        {voiceControl && voiceCatalog && (
          <section className="generation-review-voice-section" aria-label="Voice">
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
      </div>

      <section className="confirm-section generation-review-source-section" aria-label={sourceVisible ? 'Source' : 'Payload'}>
        <div className="confirm-section-heading">
          <span>{sourceVisible ? 'Source' : 'Payload'}</span>
          {(previewStale || previewLoading) && <small className="generation-review-json-stale" role="status">Updating…</small>}
        </div>
        <div className="generation-review-json" tabIndex={0} aria-label={sourceVisible ? 'Generation source preview' : 'Generation payload preview'} aria-busy={previewLoading}>
          {previewLoading ? (
            <span className="generation-review-json-status" role="status">Loading preview…</span>
          ) : previewError ? (
            <span className="generation-review-json-status generation-review-json-error" role="alert">
              {previewError}
            </span>
          ) : (
            <RichJson
              value={sourceVisible ? previewJson : previewValue?.payload ?? null}
              ariaLabel={sourceVisible ? 'Generation source JSON' : 'Generation payload JSON'}
              artifactAssets={artifactAssets}
              mediaDisplay="preview"
            />
          )}
        </div>
      </section>

      <section className="confirm-section generation-review-estimate-section" aria-label="Estimate">
        <span className="confirm-section-label">Estimate</span>
        <strong>
          {previewLoading || previewStale
            ? '…'
            : !previewError && estimate.usd !== null && !estimate.unknown
              ? `$${estimate.usd.toFixed(estimate.usd < 0.01 ? 4 : 2)}`
              : '—'}
        </strong>
        <span>{estimate.currency}</span>
        <small>
          {previewLoading || previewStale
            ? 'Updating estimate…'
            : previewError || estimate.unknown || estimate.usd === null
              ? 'Cost estimate unavailable'
              : 'Estimated provider cost'}
        </small>
        {previewError && <button
          type="button"
          disabled={busy || previewLoading}
          onClick={onRefreshPreview}
        >
          <RefreshCw size={10} aria-hidden="true" />
          Retry preview
        </button>}
      </section>
    </div>
  )
}
