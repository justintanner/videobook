import { Check, X } from 'lucide-react'
import type {
  GenerationControl,
  GenerationControlValue,
  GenerationInputMode,
  NotebookGenerationAction,
} from '@/videobook/notebook-generation-actions'
import { effectiveGenerationControlValue } from '@/videobook/notebook-generation-actions'
import {
  notebookChatGenerationSettings,
  type NotebookChatGenerationDraft,
} from '@/videobook/notebook-chat-generation'
import {
  MediaLibraryAssetPreview,
  type MediaLibraryPreviewAsset,
} from './MediaLibraryAssetPreview'

export type GenerationReviewSource = {
  cellId: string
  slug: string
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
  summary: string
  onActionChange: (actionId: string) => void
  onCancel: () => void
  onModeChange: (modeId: string) => void
  onPromptChange: (prompt: string) => void
  onRefreshPreview: () => void
  onSelectSource: (cellId: string) => void
  onSettingChange: (
    name: string,
    value: GenerationControlValue | undefined,
  ) => void
}

function controlOptionValue(value: GenerationControlValue): string {
  return `${typeof value}:${String(value)}`
}

function GenerationReviewControl({
  busy,
  control,
  settings,
  onChange,
}: {
  busy: boolean
  control: GenerationControl
  settings: Record<string, GenerationControlValue>
  onChange: (value: GenerationControlValue | undefined) => void
}) {
  const rawValue = settings[control.name]
  const value = effectiveGenerationControlValue(control, settings)
  if (control.kind === 'boolean') {
    return (
      <label className="generation-review-toggle" title={control.description}>
        <span>{control.label}</span>
        <input
          type="checkbox"
          checked={value === true}
          disabled={busy}
          onChange={(event) => onChange(event.target.checked)}
        />
      </label>
    )
  }
  if (control.kind === 'select') {
    const encodedValue = rawValue === undefined ? '' : controlOptionValue(rawValue)
    return (
      <label title={control.description}>
        <span>{control.label}</span>
        <select
          aria-label={control.label}
          value={encodedValue}
          disabled={busy}
          onChange={(event) => {
            const selected = control.options.find((option) =>
              controlOptionValue(option) === event.target.value)
            onChange(selected)
          }}
        >
          <option value="">
            {control.defaultValue === undefined
              ? control.required ? 'Select…' : 'Auto'
              : `Default · ${String(control.defaultValue)}`}
          </option>
          {control.options.map((option) => (
            <option key={controlOptionValue(option)} value={controlOptionValue(option)}>
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <label title={control.description}>
      <span>{control.label}</span>
      <input
        type={control.kind === 'number' ? 'number' : 'text'}
        aria-label={control.label}
        min={control.minimum}
        max={control.maximum}
        step={control.kind === 'number' ? 'any' : undefined}
        value={value === undefined ? '' : String(value)}
        disabled={busy}
        onChange={(event) => {
          const next = event.target.value
          if (!next) {
            onChange(undefined)
            return
          }
          const numeric = Number(next)
          onChange(control.kind === 'number'
            ? Number.isFinite(numeric) ? numeric : undefined
            : next)
        }}
      />
    </label>
  )
}

function generationMode(draft: NotebookChatGenerationDraft): string {
  const inputs = draft.cell.inputs
  return inputs && typeof inputs.generationMode === 'string'
    ? inputs.generationMode
    : ''
}

function valueRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
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
  summary,
  onActionChange,
  onCancel,
  onModeChange,
  onPromptChange,
  onRefreshPreview,
  onSelectSource,
  onSettingChange,
}: GenerationChatReviewProps) {
  const settings = notebookChatGenerationSettings(draft)
  const previewValue = valueRecord(preview)
  const estimate = valueRecord(previewValue?.estimate)
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
  const previewJson = previewValue ?? {
    tool: draft.action.tool,
    provider: draft.action.provider,
    model: draft.action.model,
    payload: {
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
            disabled={busy || !draft.cell.prompt?.trim()}
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
            {sources.length > 0 ? sources.map((source) => (
              <button
                type="button"
                className="generation-review-source"
                key={source.cellId}
                disabled={busy}
                onClick={() => onSelectSource(source.cellId)}
                title={`Select @${source.slug} on the board`}
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
                  <strong>@{source.slug}</strong>
                  <small>{source.type.replaceAll('_', ' ')}</small>
                </span>
              </button>
            )) : (
              <div className="generation-review-text-input">
                <span>Input</span>
                <strong>Prompt only</strong>
                <small>No source media attached</small>
              </div>
            )}
          </div>
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

        <section className="generation-review-section generation-review-settings-section">
          <span className="generation-review-label">Settings</span>
          <div className="generation-review-settings">
            {draft.action.controls.length > 0 ? draft.action.controls.map((control) => (
              <GenerationReviewControl
                key={control.name}
                busy={busy}
                control={control}
                settings={settings}
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
            {previewError
              ? 'Estimate unavailable'
              : previewStale
                ? 'Prompt changed · refresh estimate'
                : estimateWarnings[0] ?? 'Estimated provider cost'}
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
