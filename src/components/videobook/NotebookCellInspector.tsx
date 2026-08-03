import {
  AudioWaveform,
  Braces,
  ChevronDown,
  CircleAlert,
  CircleX,
  Film,
  Image as ImageIcon,
  Layers2,
  Maximize2,
  Save,
} from 'lucide-react'
import { Fragment, useRef, useState } from 'react'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import {
  notebookGridAddress,
  notebookGridTag,
} from 'videobook-engine/notebook-grid'
import {
  doltCellDisplayValue,
  doltCellRows,
} from '@/videobook/dolt-cell-source'
import {
  formatMediaTime,
  notebookAudioPresentation,
  notebookAnalysisLlmExchanges,
  notebookCellActionPresentation,
  notebookCellInspectorActionLabel,
  notebookOutputVersionArtifactIds,
  type NotebookAnalysisInfo,
  type NotebookAnalysisLlmExchange,
  type NotebookAnalysisResponseFormat,
  type NotebookAudioInfo,
} from '@/videobook/notebook-cell-presentation'
import {
  persistAndRunNotebookCell,
  type NotebookCellUpdate,
} from '@/videobook/notebook-cell-actions'
import {
  compatibleGenerationActions,
  compatibleGenerationModes,
  effectiveGenerationControlValue,
  effectiveGenerationSettings,
  generationActionForSelection,
  generationActionIsCompatible,
  generationActionLabel,
  generationConnectedInputs,
  generationModeIsCompatible,
  generationModeLabel,
  generationSelectionForAction,
  initialGenerationSelection,
  initialGenerationMode,
  isGenerationCellType,
  type GenerationControl,
  type GenerationControlValue,
  type GenerationPreviewDraft,
  type GenerationSelection,
  type NotebookGenerationAction,
} from '@/videobook/notebook-generation-actions'
import { NotebookMediaMetadata } from './NotebookMediaMetadata'
import { RichJson } from './RichJson'

const actionCellTypes = new Set<NotebookCell['type']>([
  'extract_audio',
  'extract_frame',
  'split_video',
  'prompt',
  'analyze',
  'concat',
  'splice',
])

function isActionCellType(
  type: NotebookCell['type'],
): boolean {
  return actionCellTypes.has(type)
}

type CellFormDraft = {
  prompt: string
  provider: string
  model: string
  operation: string
  tool: string
  startSeconds: string
  endSeconds: string
  overlap: string
  frameMode: 'first' | 'time' | 'last'
  timestampSeconds: string
  generationMode: string
  generationSettings: Record<string, GenerationControlValue>
}

const cellFormDraftFields = [
  'prompt',
  'provider',
  'model',
  'operation',
  'tool',
  'startSeconds',
  'endSeconds',
  'overlap',
  'frameMode',
  'timestampSeconds',
  'generationMode',
] as const satisfies readonly (keyof CellFormDraft)[]

function draftNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : '0'
}

function persistedGenerationSettings(
  cell: NotebookCell,
  controls: readonly GenerationControl[] = [],
): Record<string, GenerationControlValue> {
  const value = cell.inputs?.generationSettings
  const nested = !value || typeof value !== 'object' || Array.isArray(value)
    ? {}
    : Object.fromEntries(Object.entries(value).filter((entry): entry is [
        string,
        GenerationControlValue,
      ] => {
        const setting = entry[1]
        return typeof setting === 'string'
          || typeof setting === 'number'
          || typeof setting === 'boolean'
      }))
  const legacy = Object.fromEntries(controls.flatMap((control) => {
    const setting = cell.inputs?.[control.name]
    return typeof setting === 'string'
      || typeof setting === 'number'
      || typeof setting === 'boolean'
      ? [[control.name, setting] as const]
      : []
  }))
  return { ...legacy, ...nested }
}

function persistedCellFormDraft(
  cell: NotebookCell,
  controls: readonly GenerationControl[] = [],
): CellFormDraft {
  const configuredFrameMode = cell.inputs?.frameMode
  return {
    prompt: cell.prompt ?? '',
    provider: cell.provider ?? '',
    model: cell.model ?? '',
    operation: cell.operation ?? '',
    tool: cell.tool ?? '',
    startSeconds: draftNumber(cell.inputs?.startSeconds),
    endSeconds: draftNumber(cell.inputs?.endSeconds),
    overlap: draftNumber(cell.inputs?.overlap),
    frameMode: configuredFrameMode === 'time' || configuredFrameMode === 'last'
      ? configuredFrameMode
      : 'first',
    timestampSeconds: draftNumber(cell.inputs?.timestampSeconds),
    generationMode: typeof cell.inputs?.generationMode === 'string'
      ? cell.inputs.generationMode
      : '',
    generationSettings: persistedGenerationSettings(cell, controls),
  }
}

function cellFormDraft(
  cell: NotebookCell,
  actions: readonly NotebookGenerationAction[],
  inputs: Parameters<typeof initialGenerationSelection>[2] = [],
): CellFormDraft {
  const selection = initialGenerationSelection(cell, actions, inputs)
  if (!selection || !isGenerationCellType(cell.type)) {
    return persistedCellFormDraft(cell)
  }
  const action = generationActionForSelection(actions, cell.type, selection)
  const draft = persistedCellFormDraft(cell, action?.controls)
  return { ...draft, ...selection }
}

function cellFormIsDirty(
  cell: NotebookCell,
  draft: CellFormDraft,
  controls: readonly GenerationControl[] = [],
): boolean {
  const persisted = persistedCellFormDraft(cell, controls)
  return cellFormDraftFields.some((field) => draft[field] !== persisted[field])
    || JSON.stringify(draft.generationSettings)
      !== JSON.stringify(persisted.generationSettings)
}

function validTimingValue(value: string): boolean {
  if (!value.trim()) return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
}

function cellFormIsValid(cell: NotebookCell, draft: CellFormDraft): boolean {
  if (isGenerationCellType(cell.type)) {
    return Boolean(
      draft.provider.trim()
      && draft.model.trim()
      && draft.operation.trim()
      && draft.tool.trim(),
    )
  }
  if (cell.type === 'split_video') {
    return validTimingValue(draft.startSeconds)
      && validTimingValue(draft.endSeconds)
  }
  if (cell.type === 'splice' && draft.operation === 'splice_video') {
    return validTimingValue(draft.overlap)
  }
  if (cell.type === 'extract_frame' && draft.frameMode === 'time') {
    return validTimingValue(draft.timestampSeconds)
  }
  return true
}

function generationInputsForDraft(
  cell: NotebookCell,
  draft: CellFormDraft,
  controls: readonly GenerationControl[] = [],
): Record<string, unknown> {
  const inputs = { ...(cell.inputs ?? {}) }
  delete inputs.generationMode
  delete inputs.generationSettings
  for (const control of controls) delete inputs[control.name]
  return {
    ...inputs,
    ...(draft.generationMode
      ? { generationMode: draft.generationMode }
      : {}),
    ...(Object.keys(draft.generationSettings).length > 0
      ? { generationSettings: draft.generationSettings }
      : {}),
  }
}

function generationControlIsValid(
  control: GenerationControl,
  settings: Record<string, GenerationControlValue>,
): boolean {
  const value = effectiveGenerationControlValue(control, settings)
  if (value === undefined || value === '') return !control.required
  if (
    control.options.length > 0
    && !control.options.some((option) => option === value)
  ) return false
  if (control.valueType === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false
    if (control.minimum !== undefined && value < control.minimum) return false
    if (control.maximum !== undefined && value > control.maximum) return false
  }
  return typeof value === control.valueType
}

function generationControlsAreValid(
  controls: readonly GenerationControl[],
  settings: Record<string, GenerationControlValue>,
): boolean {
  return controls.every((control) =>
    generationControlIsValid(control, settings))
}

function cellFormPatch(
  cell: NotebookCell,
  draft: CellFormDraft,
  controls: readonly GenerationControl[] = [],
  controlsToClear: readonly GenerationControl[] = controls,
): Record<string, unknown> {
  const persisted = persistedCellFormDraft(cell, controls)
  const patch: Record<string, unknown> = {}
  if (draft.prompt !== persisted.prompt) patch.prompt = draft.prompt
  if (!isActionCellType(cell.type)) {
    if (draft.provider !== persisted.provider) {
      patch.provider = draft.provider || undefined
    }
    if (draft.model !== persisted.model) patch.model = draft.model || undefined
    if (draft.operation !== persisted.operation) {
      patch.operation = draft.operation || undefined
    }
    if (draft.tool !== persisted.tool) patch.tool = draft.tool || undefined
  }
  if (
    isGenerationCellType(cell.type)
    && (
      draft.generationMode !== persisted.generationMode
      || JSON.stringify(draft.generationSettings)
        !== JSON.stringify(persisted.generationSettings)
    )
  ) {
    patch.inputs = generationInputsForDraft(cell, draft, controlsToClear)
  }
  if (
    cell.type === 'split_video'
    && (
      draft.startSeconds !== persisted.startSeconds
      || draft.endSeconds !== persisted.endSeconds
    )
  ) {
    patch.inputs = {
      ...(cell.inputs ?? {}),
      startSeconds: Number(draft.startSeconds),
      endSeconds: Number(draft.endSeconds),
    }
  }
  if (
    cell.type === 'splice'
    && draft.operation === 'splice_video'
    && draft.overlap !== persisted.overlap
  ) {
    patch.inputs = {
      ...(cell.inputs ?? {}),
      overlap: Number(draft.overlap),
    }
  }
  if (
    cell.type === 'extract_frame'
    && (
      draft.frameMode !== persisted.frameMode
      || (
        draft.frameMode === 'time'
        && draft.timestampSeconds !== persisted.timestampSeconds
      )
    )
  ) {
    patch.inputs = {
      ...(cell.inputs ?? {}),
      frameMode: draft.frameMode,
      ...(draft.frameMode === 'time'
        ? { timestampSeconds: Number(draft.timestampSeconds) }
        : {}),
    }
  }
  return patch
}

export type NotebookCellInspectorAsset = {
  artifactId: string
  id: string
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  width: number | null
  height: number | null
  duration: number | null
  audioInfo: NotebookAudioInfo | null
  analysisInfo?: NotebookAnalysisInfo | null
}

type NotebookCellInspectorProps = {
  notebookId: string
  cell: NotebookCell
  cells: NotebookCell[]
  edges: NotebookEdge[]
  asset: NotebookCellInspectorAsset | undefined
  cellAssets?: ReadonlyMap<string, NotebookCellInspectorAsset>
  versionAssets?: readonly NotebookCellInspectorAsset[]
  status: string
  error: string | null
  busy: boolean
  clearing: boolean
  deleting: boolean
  sourceVisible: boolean
  generationActions?: readonly NotebookGenerationAction[]
  onUpdate: NotebookCellUpdate
  onSetInput: (targetInput: string, sourceCellId: string | null) => Promise<void>
  onRun: (cellId: string) => Promise<unknown>
  onClearSlot: () => Promise<void>
  onDelete: () => Promise<void>
  onOpenFullscreen: () => void
  onPreviewPayload?: (
    cellId: string,
    draft: GenerationPreviewDraft,
  ) => Promise<unknown>
}

function isPassiveOutputCell(cell: NotebookCell): boolean {
  return cell.type === 'audio'
    || cell.type === 'image'
    || cell.type === 'video'
    || cell.type === 'analysis'
}

function defaultInputNames(cell: NotebookCell): string[] {
  if (cell.type === 'extract_audio') return ['video']
  if (cell.type === 'extract_frame') return ['video']
  if (cell.type === 'split_video') return ['video', 'analysis']
  if (cell.type === 'analysis') return ['result']
  if (cell.type === 'image') return ['media', 'segment']
  if (cell.type === 'audio' || cell.type === 'video') return ['media']
  return []
}

function cellInputNames(cell: NotebookCell, edges: NotebookEdge[]): string[] {
  const connected = edges
    .filter((edge) => edge.target === cell.id)
    .map((edge) => edge.targetInput)
  return [...new Set([...defaultInputNames(cell), ...connected])]
}

function isVideoProducingSource(cell: NotebookCell): boolean {
  return cell.type === 'video'
    || cell.type === 'generate_video'
    || cell.type === 'concat'
    || cell.type === 'splice'
}

function compatibleSource(
  target: NotebookCell,
  targetInput: string,
  source: NotebookCell,
): boolean {
  if (source.id === target.id) return false
  if (target.type === 'analysis') {
    return targetInput === 'result' && source.type === 'analyze'
  }
  if (target.type === 'extract_audio') {
    return targetInput === 'video' && isVideoProducingSource(source)
  }
  if (target.type === 'extract_frame') {
    return targetInput === 'video' && isVideoProducingSource(source)
  }
  if (target.type === 'split_video') {
    if (targetInput === 'analysis') return source.type === 'analysis'
    if (targetInput === 'video') return isVideoProducingSource(source)
    return false
  }
  if (target.type === 'prompt' && targetInput === 'analysis') {
    return source.type === 'analysis'
  }
  if (target.type === 'audio' && targetInput === 'media') {
    return source.type === 'extract_audio'
  }
  if (target.type === 'video' && targetInput === 'media') {
    return source.type === 'split_video'
  }
  if (target.type === 'image' && targetInput === 'media') {
    return source.type === 'extract_frame'
  }
  if (source.type === 'extract_frame') return false
  if (target.type === 'image' && targetInput === 'segment') {
    return source.type === 'video'
  }
  return true
}

function NotebookCellMedia({
  asset,
  slug,
  allowFullscreen,
  onOpenFullscreen,
}: {
  asset: NotebookCellInspectorAsset
  slug: string
  allowFullscreen: boolean
  onOpenFullscreen: () => void
}) {
  const mediaUrl = asset.mediaUrl
  const previewUrl = asset.thumbnailUrl ?? mediaUrl
  const isVideo = asset.type === 'video' || asset.type === 'final'
  const isAudio = asset.type === 'audio'
  const audioPresentation = notebookAudioPresentation({
    audioInfo: asset.audioInfo,
    durationSeconds: asset.duration,
    hasOutput: true,
    inputs: undefined,
  })

  if (!previewUrl) return null

  return (
    <section
      className={`inspector-cell-preview${isAudio ? ' inspector-cell-preview-audio' : ''}`}
      aria-label="Cell output media"
    >
      <div className="inspector-cell-media">
        {isVideo && mediaUrl ? (
          <video
            key={mediaUrl}
            src={mediaUrl}
            poster={asset.thumbnailUrl ?? undefined}
            controls
            controlsList="nofullscreen nodownload noremoteplayback"
            disablePictureInPicture
            playsInline
            preload="metadata"
          />
        ) : isAudio && mediaUrl ? (
          <audio key={mediaUrl} src={mediaUrl} controls preload="metadata" />
        ) : (
          <img key={previewUrl} src={previewUrl} alt={`@${slug}`} />
        )}
        {!isAudio && (
          <NotebookMediaMetadata
            className="inspector-cell-metadata"
            width={asset.width}
            height={asset.height}
            durationSeconds={isVideo ? asset.duration : null}
            fallbackLabel={asset.type.toUpperCase()}
          />
        )}
      </div>
      {isAudio && (
        <div className="inspector-audio-summary">
          <span className="inspector-audio-role">{audioPresentation.role}</span>
          <dl className="inspector-audio-facts">
            <div>
              <dt>Duration</dt>
              <dd>{audioPresentation.duration ?? 'Unknown'}</dd>
            </div>
            {audioPresentation.details.length > 0 && (
              <div>
                <dt>Format</dt>
                <dd>{audioPresentation.details.join(' · ')}</dd>
              </div>
            )}
          </dl>
        </div>
      )}
      {allowFullscreen && !isAudio && (
        <button
          type="button"
          className="inspector-fullscreen-button"
          onClick={onOpenFullscreen}
        >
          <Maximize2 size={14} />Fullscreen
        </button>
      )}
    </section>
  )
}

function DoltCellSource({
  notebookId,
  cell,
}: {
  notebookId: string
  cell: NotebookCell
}) {
  const rows = doltCellRows(notebookId, cell)

  return (
    <section className="inspector-source inspector-dolt-source">
      <header className="inspector-source-meta">
        <span>Dolt source</span>
        <code>cells · {rows.length} columns</code>
      </header>
      <table className="inspector-dolt-table" aria-label="Raw Dolt cells row">
        <thead>
          <tr>
            <th>Column</th>
            <th>Type</th>
            <th>Raw value</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const displayValue = doltCellDisplayValue(row)

            if (displayValue.kind === 'json') {
              return (
                <Fragment key={row.column}>
                  <tr className="inspector-dolt-json-meta">
                    <th scope="row">{row.column}</th>
                    <td>{row.type}</td>
                    <td><code className="dolt-json-kind">JSON</code></td>
                  </tr>
                  <tr className="inspector-dolt-json-value">
                    <td colSpan={3}>
                      <RichJson
                        value={displayValue.value}
                        ariaLabel={`${row.column} JSON`}
                      />
                    </td>
                  </tr>
                </Fragment>
              )
            }

            return (
              <tr key={row.column}>
                <th scope="row">{row.column}</th>
                <td>{row.type}</td>
                <td>
                  <code className={displayValue.kind === 'null' ? 'dolt-null' : undefined}>
                    {displayValue.kind === 'null' ? 'NULL' : String(displayValue.value)}
                  </code>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </section>
  )
}

function sourceCellTypeLabel(cell: NotebookCell): string {
  return cell.type.replaceAll('_', ' ')
}

function SourceCellThumb({
  cell,
  asset,
}: {
  cell: NotebookCell
  asset: NotebookCellInspectorAsset | undefined
}) {
  const thumbnailUrl = asset?.thumbnailUrl
    ?? (asset?.type === 'image' ? asset.mediaUrl : null)
  const kind = asset?.type ?? cell.type
  const audio = kind === 'audio'
    || cell.type === 'generate_audio'
    || cell.type === 'extract_audio'
  const video = kind === 'video'
    || kind === 'final'
    || cell.type === 'generate_video'
    || cell.type === 'split_video'
    || cell.type === 'concat'
    || cell.type === 'splice'
  const image = kind === 'image'
    || cell.type === 'generate_image'
    || cell.type === 'extract_frame'
  const videoUrl = !thumbnailUrl && (kind === 'video' || kind === 'final')
    ? asset?.mediaUrl
    : null

  return (
    <span className="inspector-source-thumb" aria-hidden="true">
      {thumbnailUrl ? (
        <img src={thumbnailUrl} alt="" loading="lazy" decoding="async" />
      ) : videoUrl ? (
        <video src={videoUrl} muted playsInline preload="metadata" />
      ) : audio ? (
        <AudioWaveform size={16} />
      ) : video ? (
        <Film size={16} />
      ) : image ? (
        <ImageIcon size={16} />
      ) : (
        <Braces size={15} />
      )}
    </span>
  )
}

function SourceCellPicker({
  input,
  candidates,
  selectedCellId,
  cellAssets,
  busy,
  onSelect,
}: {
  input: string
  candidates: NotebookCell[]
  selectedCellId: string | null
  cellAssets?: ReadonlyMap<string, NotebookCellInspectorAsset>
  busy: boolean
  onSelect: (sourceCellId: string | null) => Promise<void>
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null)
  const selectedCell = candidates.find((candidate) =>
    candidate.id === selectedCellId)
  const choose = (sourceCellId: string | null) => {
    detailsRef.current?.removeAttribute('open')
    if (sourceCellId === selectedCellId) return
    void onSelect(sourceCellId)
  }

  return (
    <details
      ref={detailsRef}
      className="inspector-source-picker"
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) {
          return
        }
        event.currentTarget.removeAttribute('open')
      }}
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return
        event.preventDefault()
        detailsRef.current?.removeAttribute('open')
        detailsRef.current?.querySelector<HTMLElement>('summary')?.focus()
      }}
    >
      <summary
        aria-label={`${input.replaceAll('_', ' ')} input`}
        title={`${input.replaceAll('_', ' ')} input`}
        aria-disabled={busy}
        tabIndex={busy ? -1 : 0}
        onClick={(event) => {
          if (busy) event.preventDefault()
        }}
      >
        {selectedCell ? (
          <>
            <SourceCellThumb
              cell={selectedCell}
              asset={cellAssets?.get(selectedCell.id)}
            />
            <span className="inspector-source-picker-copy">
              <strong>@{selectedCell.slug}</strong>
              <small>{sourceCellTypeLabel(selectedCell)}</small>
            </span>
          </>
        ) : (
          <>
            <span
              className="inspector-source-thumb inspector-source-thumb-empty"
              aria-hidden="true"
            >
              <CircleX size={15} />
            </span>
            <span className="inspector-source-picker-copy">
              <strong>No source</strong>
              <small>Optional input</small>
            </span>
          </>
        )}
        <ChevronDown
          className="inspector-source-picker-chevron"
          size={15}
          aria-hidden="true"
        />
      </summary>
      <div
        className="inspector-source-picker-options"
        role="listbox"
        aria-label={`${input.replaceAll('_', ' ')} input options`}
      >
        <button
          type="button"
          role="option"
          aria-selected={selectedCellId === null}
          disabled={busy}
          onClick={() => choose(null)}
        >
          <span
            className="inspector-source-thumb inspector-source-thumb-empty"
            aria-hidden="true"
          >
            <CircleX size={15} />
          </span>
          <span className="inspector-source-picker-copy">
            <strong>No source</strong>
            <small>Disconnect input</small>
          </span>
        </button>
        {candidates.map((candidate) => (
          <button
            type="button"
            role="option"
            aria-selected={candidate.id === selectedCellId}
            disabled={busy}
            key={candidate.id}
            onClick={() => choose(candidate.id)}
          >
            <SourceCellThumb
              cell={candidate}
              asset={cellAssets?.get(candidate.id)}
            />
            <span className="inspector-source-picker-copy">
              <strong>@{candidate.slug}</strong>
              <small>{sourceCellTypeLabel(candidate)}</small>
            </span>
          </button>
        ))}
      </div>
    </details>
  )
}

function InputSources({
  cell,
  cells,
  edges,
  busy,
  cellAssets,
  onSetInput,
}: {
  cell: NotebookCell
  cells: NotebookCell[]
  edges: NotebookEdge[]
  busy: boolean
  cellAssets?: ReadonlyMap<string, NotebookCellInspectorAsset>
  onSetInput: (targetInput: string, sourceCellId: string | null) => Promise<void>
}) {
  const inputs = cellInputNames(cell, edges)

  if (inputs.length === 0) return null

  return (
    <section className="inspector-input-sources">
      <h3>Inputs</h3>
      <div className="inspector-input-source-rows">
        {inputs.map((input) => {
          const edge = edges.find((candidate) =>
            candidate.target === cell.id && candidate.targetInput === input)
          const candidates = cells
            .filter((candidate) =>
              compatibleSource(cell, input, candidate)
              || candidate.id === edge?.source)
            .sort((left, right) => left.slug.localeCompare(right.slug))
          return (
            <div
              className="inspector-input-source-row"
              key={input}
            >
              <SourceCellPicker
                input={input}
                candidates={candidates}
                selectedCellId={edge?.source ?? null}
                cellAssets={cellAssets}
                busy={busy}
                onSelect={(sourceCellId) => onSetInput(input, sourceCellId)}
              />
            </div>
          )
        })}
      </div>
    </section>
  )
}

function AddressField({ cell }: { cell: NotebookCell }) {
  return (
    <div className="inspector-slug-field">
      <label>Address</label>
      <div className="inspector-slug-control inspector-address-control">
        <span className="inspector-slug-prefix">{notebookGridTag(cell.slot)}</span>
      </div>
    </div>
  )
}

function InspectorClearButton({
  className,
  label,
  pendingLabel,
  busy,
  pending,
  disabled = false,
  onClear,
}: {
  className: string
  label: string
  pendingLabel: string
  busy: boolean
  pending: boolean
  disabled?: boolean
  onClear: () => Promise<void>
}) {
  return (
    <button
      type="button"
      className={className}
      aria-busy={pending}
      onClick={() => void onClear()}
      disabled={busy || pending || disabled}
    >
      <CircleX size={13} />
      <span>{pending ? pendingLabel : label}</span>
    </button>
  )
}

function DeleteCellButton({
  busy,
  deleting,
  onDelete,
}: {
  busy: boolean
  deleting: boolean
  onDelete: () => Promise<void>
}) {
  return (
    <InspectorClearButton
      className="danger-button inspector-delete-cell-button"
      label="Delete cell"
      pendingLabel="Deleting…"
      busy={busy}
      pending={deleting}
      onClear={onDelete}
    />
  )
}

function CellCleanupActions({
  cell,
  edges,
  busy,
  clearing,
  deleting,
  onClearSlot,
  onDelete,
}: Pick<
  NotebookCellInspectorProps,
  | 'cell'
  | 'edges'
  | 'busy'
  | 'clearing'
  | 'deleting'
  | 'onClearSlot'
  | 'onDelete'
>) {
  const canClear = Boolean(cell.outputArtifactId || cell.outputEntityId)
    || edges.some((edge) => edge.target === cell.id)

  return (
    <section
      className="inspector-cell-actions inspector-compact-actions"
      aria-label="Cell cleanup actions"
    >
      <InspectorClearButton
        className="inspector-clear-slot-button"
        label="Clear slot"
        pendingLabel="Clearing…"
        busy={busy}
        pending={clearing}
        disabled={!canClear}
        onClear={onClearSlot}
      />
      <DeleteCellButton busy={busy} deleting={deleting} onDelete={onDelete} />
    </section>
  )
}

function OutputVersionSelector({
  artifactIds,
  availableArtifactIds,
  currentArtifactId,
  selectedArtifactId,
  outputLabel,
  onSelect,
}: {
  artifactIds: readonly string[]
  availableArtifactIds: ReadonlySet<string>
  currentArtifactId: string | undefined
  selectedArtifactId: string
  outputLabel: string
  onSelect: (artifactId: string) => void
}) {
  const selectedVersion = artifactIds.indexOf(selectedArtifactId) + 1
  const viewingCurrent = selectedArtifactId === currentArtifactId

  return (
    <section
      className="inspector-audio-versions"
      aria-label={`${outputLabel} versions`}
    >
      <span className="inspector-audio-version-label">
        <Layers2 size={13} aria-hidden="true" />
        Version
      </span>
      <select
        value={selectedArtifactId}
        aria-label={`${outputLabel} version`}
        onChange={(event) => onSelect(event.target.value)}
      >
        {artifactIds.map((artifactId, index) => (
          <option
            key={artifactId}
            value={artifactId}
            disabled={!availableArtifactIds.has(artifactId)}
          >
            Version {index + 1} of {artifactIds.length}
            {artifactId === currentArtifactId ? ' · current' : ''}
          </option>
        ))}
      </select>
      <span
        className={`inspector-audio-version-state${viewingCurrent ? ' current' : ''}`}
        aria-live="polite"
      >
        {viewingCurrent
          ? 'Current output'
          : `Viewing version ${selectedVersion}`}
      </span>
    </section>
  )
}

function MediaCellInspector({
  cell,
  cells,
  edges,
  asset,
  cellAssets,
  versionAssets,
  busy,
  clearing,
  deleting,
  onSetInput,
  onClearSlot,
  onDelete,
  onOpenFullscreen,
}: Pick<
  NotebookCellInspectorProps,
  | 'cell'
  | 'cells'
  | 'edges'
  | 'asset'
  | 'cellAssets'
  | 'versionAssets'
  | 'busy'
  | 'clearing'
  | 'deleting'
  | 'onUpdate'
  | 'onSetInput'
  | 'onClearSlot'
  | 'onDelete'
  | 'onOpenFullscreen'
>) {
  const versionArtifactIds = cell.type === 'audio' || cell.type === 'image'
    ? notebookOutputVersionArtifactIds(cell.inputs, cell.outputArtifactId)
    : []
  const versionKey = versionArtifactIds.join(':')
  const currentVersionArtifactId = cell.outputArtifactId
    ?? versionArtifactIds.at(-1)
    ?? ''
  const [versionSelection, setVersionSelection] = useState<{
    artifactId: string
    cellId: string
    currentArtifactId: string
    versionKey: string
  } | null>(null)
  const selectedVersionArtifactId = (
    versionSelection?.cellId === cell.id
    && versionSelection.currentArtifactId === currentVersionArtifactId
    && versionSelection.versionKey === versionKey
  )
    ? versionSelection.artifactId
    : currentVersionArtifactId
  const versionAssetById = new Map(
    (versionAssets ?? []).map((versionAsset) => [
      versionAsset.artifactId,
      versionAsset,
    ]),
  )
  if (asset) versionAssetById.set(asset.artifactId, asset)
  const selectedVersionAvailable = versionAssetById.has(
    selectedVersionArtifactId,
  )
  const effectiveVersionArtifactId = (
    versionArtifactIds.includes(selectedVersionArtifactId)
    && selectedVersionAvailable
  )
    ? selectedVersionArtifactId
    : currentVersionArtifactId
  const previewAsset = versionArtifactIds.length > 0
    ? versionAssetById.get(effectiveVersionArtifactId) ?? asset
    : asset
  const availableVersionArtifactIds = new Set(versionAssetById.keys())
  const selectVersion = (artifactId: string) => {
    setVersionSelection({
      artifactId,
      cellId: cell.id,
      currentArtifactId: currentVersionArtifactId,
      versionKey,
    })
  }

  return (
    <div className="inspector-body inspector-media-body">
      <div className="inspector-media-content">
        <AddressField cell={cell} />
        <span className="inspector-media-field-label">
          {cell.type.replaceAll('_', ' ').toUpperCase()}
        </span>
        {versionArtifactIds.length > 1 && previewAsset && (
          <OutputVersionSelector
            artifactIds={versionArtifactIds}
            availableArtifactIds={availableVersionArtifactIds}
            currentArtifactId={cell.outputArtifactId}
            selectedArtifactId={effectiveVersionArtifactId}
            outputLabel={cell.type === 'image' ? 'Image' : 'Audio'}
            onSelect={selectVersion}
          />
        )}
        {previewAsset ? (
          <NotebookCellMedia
            asset={previewAsset}
            slug={notebookGridAddress(cell.slot)}
            allowFullscreen={cell.type === 'image' || cell.type === 'video'}
            onOpenFullscreen={onOpenFullscreen}
          />
        ) : (
          <div className="inspector-media-empty">
            <span>Output pending</span>
            <p>Connect a source and rerun its producer to populate this preview.</p>
          </div>
        )}
        <InputSources
          cell={cell}
          cells={cells}
          edges={edges}
          busy={busy}
          cellAssets={cellAssets}
          onSetInput={onSetInput}
        />
        <CellCleanupActions
          cell={cell}
          edges={edges}
          busy={busy}
          clearing={clearing}
          deleting={deleting}
          onClearSlot={onClearSlot}
          onDelete={onDelete}
        />
      </div>
    </div>
  )
}

function AnalysisJsonDisclosure({
  label,
  summary,
  className,
  value,
  loadValue,
  ariaLabel,
}: {
  label: string
  summary?: string
  className?: string
  value?: unknown
  loadValue?: () => Promise<unknown>
  ariaLabel: string
}) {
  const [open, setOpen] = useState(false)
  const [resolvedValue, setResolvedValue] = useState(value)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <details
      className={[
        'inspector-analysis-json-disclosure',
        className,
      ].filter(Boolean).join(' ')}
      aria-busy={loading}
      onToggle={(event) => {
        const nextOpen = event.currentTarget.open
        setOpen(nextOpen)
        if (
          !nextOpen
          || resolvedValue !== undefined
          || !loadValue
          || loading
        ) {
          return
        }
        setLoading(true)
        setError(null)
        void loadValue()
          .then((nextValue) => setResolvedValue(nextValue))
          .catch((loadError: unknown) => {
            setError(
              loadError instanceof Error
                ? loadError.message
                : String(loadError),
            )
          })
          .finally(() => setLoading(false))
      }}
    >
      <summary>
        <Braces size={12} aria-hidden="true" />
        <span>{label}</span>
        {summary && <code className="inspector-json-summary">{summary}</code>}
      </summary>
      {open && resolvedValue !== undefined && (
        <div className="inspector-analysis-json-scroll" tabIndex={0}>
          <RichJson value={resolvedValue} ariaLabel={ariaLabel} />
        </div>
      )}
      {open && resolvedValue === undefined && (
        <div className="inspector-analysis-json-status" role="status">
          {loading
            ? 'Loading complete JSON…'
            : error ?? 'Complete JSON is unavailable for this run.'}
        </div>
      )}
    </details>
  )
}

function analysisStageLabel(stage: string): string {
  return stage
    .replace(/^notebook_/, '')
    .replace(/^legacy_/, '')
    .replaceAll('_', ' ')
}

function analysisResponseFormatLabel(
  format: NotebookAnalysisResponseFormat,
): string {
  if (format.type === 'json_schema') {
    return format.strict ? 'Strict JSON schema' : 'JSON schema'
  }
  if (format.type === 'json_object') return 'JSON object'
  if (format.type === 'text') return 'Text'
  return format.type.replaceAll('_', ' ')
}

function AnalysisLlmExchanges({
  analysisInfo,
}: {
  analysisInfo: NotebookAnalysisInfo
}) {
  const inlineExchanges = notebookAnalysisLlmExchanges(
    analysisInfo.outputJson,
  )
  const exchanges = analysisInfo.llmExchanges?.length
    ? analysisInfo.llmExchanges.map((exchange) => ({
        ...exchange,
        complete: true,
        input: undefined,
        response: undefined,
      }))
    : inlineExchanges
  const exchangeLoadRef = useRef<
    Promise<NotebookAnalysisLlmExchange[]> | null
  >(null)
  const loadExchanges = (): Promise<NotebookAnalysisLlmExchange[]> => {
    if (!analysisInfo.outputUrl) {
      return Promise.reject(
        new Error('Complete JSON is unavailable for this run.'),
      )
    }
    if (!exchangeLoadRef.current) {
      const load = fetch(analysisInfo.outputUrl)
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Unable to load complete JSON (${response.status})`)
          }
          return response.json() as Promise<unknown>
        })
        .then((outputJson) => {
          const loaded = notebookAnalysisLlmExchanges(outputJson)
          if (loaded.length === 0) {
            throw new Error('The saved analysis has no recorded LLM exchange.')
          }
          return loaded
        })
      exchangeLoadRef.current = load.catch((loadError: unknown) => {
        exchangeLoadRef.current = null
        throw loadError
      })
    }
    return exchangeLoadRef.current
  }
  const loadExchangeValue = (
    index: number,
    key: 'input' | 'response',
  ) => async (): Promise<unknown> => {
    const loaded = await loadExchanges()
    const exchange = loaded[index]
    if (!exchange) {
      throw new Error('The saved LLM exchange could not be found.')
    }
    return exchange[key]
  }
  if (exchanges.length === 0) return null

  return (
    <section
      className="inspector-analysis-llm"
      aria-label="LLM exchanges"
    >
      <header className="inspector-analysis-llm-heading">
        <span>LLM exchange</span>
        <code>{exchanges.length} {exchanges.length === 1 ? 'call' : 'calls'}</code>
      </header>
      <div className="inspector-analysis-llm-calls">
        {exchanges.map((exchange, index) => {
          const stage = analysisStageLabel(exchange.stage)
          const ordinal = String(index + 1).padStart(2, '0')

          return (
            <article
              className="inspector-analysis-llm-call"
              key={`${exchange.stage}-${index}`}
            >
              <header>
                <span>{ordinal}</span>
                <strong>{stage}</strong>
              </header>
              <dl className="inspector-analysis-llm-meta">
                <div>
                  <dt>Provider</dt>
                  <dd>{exchange.provider}</dd>
                </div>
                <div>
                  <dt>Model</dt>
                  <dd>{exchange.model}</dd>
                </div>
                {exchange.responseFormat && (
                  <div className="inspector-analysis-llm-format">
                    <dt>Response format</dt>
                    <dd>
                      <span>
                        <Braces size={11} aria-hidden="true" />
                        {analysisResponseFormatLabel(exchange.responseFormat)}
                      </span>
                      {exchange.responseFormat.name && (
                        <code>{exchange.responseFormat.name}</code>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {!exchange.complete && (
                <p className="inspector-analysis-llm-incomplete">
                  This older run retained summary payloads only. Re-run the
                  Analyze cell to record the complete provider exchange.
                </p>
              )}
              <div className="inspector-analysis-json-disclosures">
                <AnalysisJsonDisclosure
                  label="LLM input"
                  value={exchange.input}
                  loadValue={
                    exchange.input === undefined
                      ? loadExchangeValue(index, 'input')
                      : undefined
                  }
                  ariaLabel={`LLM input JSON for ${stage}`}
                />
                <AnalysisJsonDisclosure
                  label="LLM response"
                  value={exchange.response}
                  loadValue={
                    exchange.response === undefined
                      ? loadExchangeValue(index, 'response')
                      : undefined
                  }
                  ariaLabel={`LLM response JSON for ${stage}`}
                />
              </div>
            </article>
          )
        })}
      </div>
    </section>
  )
}

function AnalysisCellInspector({
  cell,
  cells,
  edges,
  asset,
  cellAssets,
  versionAssets,
  busy,
  clearing,
  deleting,
  onSetInput,
  onClearSlot,
  onDelete,
}: Pick<
  NotebookCellInspectorProps,
  | 'cell'
  | 'cells'
  | 'edges'
  | 'asset'
  | 'cellAssets'
  | 'versionAssets'
  | 'busy'
  | 'clearing'
  | 'deleting'
  | 'onUpdate'
  | 'onSetInput'
  | 'onClearSlot'
  | 'onDelete'
>) {
  const artifactIds = notebookOutputVersionArtifactIds(
    cell.inputs,
    cell.outputArtifactId,
  )
  const versionKey = artifactIds.join(':')
  const currentArtifactId = cell.outputArtifactId ?? artifactIds.at(-1) ?? ''
  const [selection, setSelection] = useState<{
    artifactId: string
    cellId: string
    currentArtifactId: string
    versionKey: string
  } | null>(null)
  const selectedArtifactId = (
    selection?.cellId === cell.id
    && selection.currentArtifactId === currentArtifactId
    && selection.versionKey === versionKey
  )
    ? selection.artifactId
    : currentArtifactId
  const assetById = new Map(
    (versionAssets ?? []).map((versionAsset) => [
      versionAsset.artifactId,
      versionAsset,
    ]),
  )
  if (asset) assetById.set(asset.artifactId, asset)
  const effectiveArtifactId = (
    artifactIds.includes(selectedArtifactId)
    && assetById.has(selectedArtifactId)
  )
    ? selectedArtifactId
    : currentArtifactId
  const previewAsset = assetById.get(effectiveArtifactId) ?? asset
  const info = previewAsset?.analysisInfo
  const shots = info?.shots
    .slice()
    .sort((left, right) => left.ordinal - right.ordinal) ?? []

  return (
    <div className="inspector-body inspector-analysis-body">
      <div className="inspector-analysis-content">
        <AddressField cell={cell} />
        {artifactIds.length > 1 && (
          <OutputVersionSelector
            artifactIds={artifactIds}
            availableArtifactIds={new Set(assetById.keys())}
            currentArtifactId={cell.outputArtifactId}
            selectedArtifactId={effectiveArtifactId}
            outputLabel="Analysis"
            onSelect={(artifactId) => {
              setSelection({
                artifactId,
                cellId: cell.id,
                currentArtifactId,
                versionKey,
              })
            }}
          />
        )}
        {info ? (
          <>
            <AnalysisLlmExchanges
              key={effectiveArtifactId}
              analysisInfo={info}
            />
            <ol className="inspector-analysis-shots">
              {shots.map((shot) => (
                <li key={shot.ordinal}>
                  <span className="inspector-analysis-shot-number">
                    {String(shot.ordinal).padStart(2, '0')}
                  </span>
                  <div>
                    <strong>{shot.label}</strong>
                    <time>
                      {formatMediaTime(shot.startSeconds)}
                      {' – '}
                      {formatMediaTime(shot.endSeconds)}
                      {' · '}
                      {formatMediaTime(shot.durationSeconds)}
                    </time>
                  </div>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <div className="inspector-media-empty">
            <span>Analysis pending</span>
            <p>Run the connected Analyze cell to populate normalized shots.</p>
          </div>
        )}
        <InputSources
          cell={cell}
          cells={cells}
          edges={edges}
          busy={busy}
          cellAssets={cellAssets}
          onSetInput={onSetInput}
        />
        <CellCleanupActions
          cell={cell}
          edges={edges}
          busy={busy}
          clearing={clearing}
          deleting={deleting}
          onClearSlot={onClearSlot}
          onDelete={onDelete}
        />
      </div>
    </div>
  )
}

function generationControlOptionValue(value: GenerationControlValue): string {
  return `${typeof value}:${String(value)}`
}

function GenerationControlField({
  control,
  settings,
  busy,
  onChange,
}: {
  control: GenerationControl
  settings: Record<string, GenerationControlValue>
  busy: boolean
  onChange: (value: GenerationControlValue | undefined) => void
}) {
  const rawValue = settings[control.name]
  const value = effectiveGenerationControlValue(control, settings)
  if (control.kind === 'boolean') {
    return (
      <label className="inspector-generation-toggle" title={control.description}>
        <input
          type="checkbox"
          checked={value === true}
          disabled={busy}
          onChange={(event) => onChange(event.target.checked)}
        />
        <span>{control.label}</span>
      </label>
    )
  }
  if (control.kind === 'select') {
    const encodedValue = rawValue === undefined
      ? ''
      : generationControlOptionValue(rawValue)
    const savedOption = rawValue !== undefined
      && !control.options.some((option) => option === rawValue)
    return (
      <label title={control.description}>
        {control.label}
        <select
          aria-label={control.label}
          value={encodedValue}
          disabled={busy}
          onChange={(event) => {
            const selected = control.options.find((option) =>
              generationControlOptionValue(option) === event.target.value)
            onChange(selected)
          }}
        >
          <option value="">
            {control.defaultValue === undefined
              ? control.required ? 'Select…' : 'Auto'
              : `Default · ${String(control.defaultValue)}`}
          </option>
          {savedOption && (
            <option value={encodedValue}>{String(rawValue)} · incompatible</option>
          )}
          {control.options.map((option) => (
            <option
              key={generationControlOptionValue(option)}
              value={generationControlOptionValue(option)}
            >
              {String(option)}
            </option>
          ))}
        </select>
      </label>
    )
  }
  return (
    <label title={control.description}>
      {control.label}
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

function ExecutableCellInspector({
  cell,
  cells,
  edges,
  asset,
  cellAssets,
  status,
  error,
  busy,
  clearing,
  deleting,
  onUpdate,
  onSetInput,
  onRun,
  onClearSlot,
  onDelete,
  onOpenFullscreen,
  onPreviewPayload,
  generationActions = [],
}: Pick<
  NotebookCellInspectorProps,
  | 'cell'
  | 'cells'
  | 'edges'
  | 'asset'
  | 'cellAssets'
  | 'status'
  | 'error'
  | 'busy'
  | 'clearing'
  | 'deleting'
  | 'onUpdate'
  | 'onSetInput'
  | 'onRun'
  | 'onClearSlot'
  | 'onDelete'
  | 'onOpenFullscreen'
  | 'onPreviewPayload'
  | 'generationActions'
>) {
  const [draft, setDraft] = useState(() =>
    cellFormDraft(
      cell,
      generationActions,
      generationConnectedInputs(cell.id, cells, edges),
    ))
  const [saving, setSaving] = useState(false)
  const [copyResult, setCopyResult] = useState<{
    error: string
    state: 'copied' | 'failed'
  } | null>(null)
  const textCell = cell.type === 'prompt'
    || cell.type === 'analyze'
    || cell.type === 'generate_video'
    || cell.type === 'generate_image'
    || cell.type === 'generate_audio'
  const generationCell = cell.type === 'generate_video'
    || cell.type === 'generate_image'
    || cell.type === 'generate_audio'
  const generationCellType = isGenerationCellType(cell.type)
    ? cell.type
    : null
  const generationSelection: GenerationSelection = {
    provider: draft.provider,
    model: draft.model,
    operation: draft.operation,
    tool: draft.tool,
  }
  const connectedGenerationInputs = generationCellType
    ? generationConnectedInputs(cell.id, cells, edges)
    : []
  const compatibleActions = generationCellType
    ? compatibleGenerationActions(
        generationActions,
        generationCellType,
        connectedGenerationInputs,
      )
    : []
  const selectedGenerationAction = generationCellType
    ? generationActionForSelection(
        generationActions,
        generationCellType,
        generationSelection,
      )
    : null
  const generationActionCompatible = Boolean(
    selectedGenerationAction
    && generationActionIsCompatible(
      selectedGenerationAction,
      connectedGenerationInputs,
    ),
  )
  const compatibleModes = selectedGenerationAction
    ? compatibleGenerationModes(
        selectedGenerationAction,
        connectedGenerationInputs,
      )
    : []
  const effectiveGenerationMode = selectedGenerationAction
    ? draft.generationMode || initialGenerationMode(
        selectedGenerationAction,
        connectedGenerationInputs,
      )
    : ''
  const generationModeCompatible = Boolean(
    selectedGenerationAction
    && generationModeIsCompatible(
      selectedGenerationAction,
      effectiveGenerationMode,
      connectedGenerationInputs,
    ),
  )
  const generationModeOptions = selectedGenerationAction?.inputContract.modes
    ?? []
  const generationControls = selectedGenerationAction?.controls ?? []
  const allGenerationControls = generationActions.flatMap((candidate) =>
    candidate.controls)
  const primaryGenerationControls = generationControls.filter((control) =>
    control.name === 'duration'
    || control.name === 'aspect_ratio'
    || control.name === 'resolution')
  const advancedGenerationControls = generationControls.filter((control) =>
    !primaryGenerationControls.includes(control))
  const generationSettingsValid = generationControlsAreValid(
    generationControls,
    draft.generationSettings,
  )
  const generationCompatible = generationActionCompatible
    && generationModeCompatible
    && generationSettingsValid
  const generationPickerActions = selectedGenerationAction
    && !generationActionCompatible
    && !compatibleActions.some((candidate) =>
      candidate.id === selectedGenerationAction.id)
    ? [selectedGenerationAction, ...compatibleActions]
    : compatibleActions
  const selectedGenerationValue = selectedGenerationAction?.id
    ?? draft.tool
  const payloadSettings = effectiveGenerationSettings(
    generationControls,
    draft.generationSettings,
  )
  const payloadSummary = JSON.stringify({
    ...(selectedGenerationAction
      ? {
          provider: selectedGenerationAction.providerLabel,
          model: selectedGenerationAction.title,
        }
      : {
          ...(draft.provider ? { provider: draft.provider } : {}),
          ...(draft.model ? { model: draft.model } : {}),
        }),
    ...(effectiveGenerationMode ? { type: effectiveGenerationMode } : {}),
    inputs: connectedGenerationInputs.length,
    settings: payloadSettings,
  })
  const action = notebookCellActionPresentation(
    generationCell
      ? {
          ...cell,
          provider: draft.provider,
          model: draft.model,
          operation: draft.operation,
          tool: draft.tool,
        }
      : cell,
    status,
  )
  const previewCell = cell.type === 'character' || generationCell
  const actionCell = isActionCellType(cell.type)
  const dirty = cellFormIsDirty(cell, draft, generationControls)
  const valid = cellFormIsValid(cell, draft)
    && (!generationCell || generationCompatible)
  const runLabel = generationCell
    ? 'Generate'
    : action
    ? notebookCellInspectorActionLabel(cell.type, action.label)
    : null
  const saveOnRun = (actionCell || generationCell) && Boolean(runLabel)
  const runError = error
    ?? 'This action failed, but no error details were recorded.'
  const copyState = copyResult?.error === runError ? copyResult.state : 'idle'
  const copyLabel = copyState === 'copied'
    ? 'Copied'
    : copyState === 'failed'
      ? 'Retry copy'
      : 'Copy'

  const updateDraft = <Field extends keyof CellFormDraft,>(
    field: Field,
    value: CellFormDraft[Field],
  ) => {
    setDraft((current) => ({ ...current, [field]: value }))
  }
  const updateGenerationAction = (actionId: string) => {
    const selected = generationPickerActions.find((candidate) =>
      candidate.id === actionId)
    if (!selected) return
    setDraft((current) => ({
      ...current,
      ...generationSelectionForAction(selected),
      generationMode: initialGenerationMode(
        selected,
        connectedGenerationInputs,
      ),
      generationSettings: {},
    }))
  }
  const updateGenerationSetting = (
    name: string,
    value: GenerationControlValue | undefined,
  ) => {
    setDraft((current) => {
      const generationSettings = { ...current.generationSettings }
      if (value === undefined) delete generationSettings[name]
      else generationSettings[name] = value
      return { ...current, generationSettings }
    })
  }
  const copyRunError = async () => {
    try {
      await navigator.clipboard.writeText(runError)
      setCopyResult({ error: runError, state: 'copied' })
    } catch {
      setCopyResult({ error: runError, state: 'failed' })
    }
  }
  const save = async () => {
    if (!dirty || !valid) return
    setSaving(true)
    try {
      await onUpdate(cellFormPatch(
        cell,
        { ...draft, generationMode: effectiveGenerationMode },
        generationControls,
        allGenerationControls,
      ))
    } finally {
      setSaving(false)
    }
  }
  const saveAndRun = async () => {
    if (!saveOnRun || busy || action?.disabled || !valid) return
    setSaving(true)
    try {
      await persistAndRunNotebookCell({
        cellId: cell.id,
        dirty,
        valid,
        patch: cellFormPatch(
          cell,
          { ...draft, generationMode: effectiveGenerationMode },
          generationControls,
          allGenerationControls,
        ),
        onUpdate,
        onRun,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="inspector-body inspector-executable-body">
      <AddressField cell={cell} />
      {asset && previewCell && (
        <NotebookCellMedia
          asset={asset}
          slug={notebookGridAddress(cell.slot)}
          allowFullscreen={false}
          onOpenFullscreen={onOpenFullscreen}
        />
      )}
      <InputSources
        cell={cell}
        cells={cells}
        edges={edges}
        busy={busy}
        cellAssets={cellAssets}
        onSetInput={onSetInput}
      />
      <form
        className={[
          'inspector-cell-form',
          generationCell ? 'inspector-generation-form' : '',
        ].filter(Boolean).join(' ')}
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault()
          if (saveOnRun) {
            void saveAndRun()
            return
          }
          void save()
        }}
      >
        {textCell && (
          <details className="inspector-prompt-disclosure" open>
            <summary>Prompt</summary>
            <textarea
              aria-label="Prompt"
              className="inspector-prompt-textarea"
              value={draft.prompt}
              rows={8}
              onChange={(event) => updateDraft('prompt', event.target.value)}
            />
          </details>
        )}
        {cell.type === 'split_video' && (
          <div className="inspector-field-pair">
            <label>
              Start seconds
              <input
                type="number"
                min="0"
                step="0.01"
                value={draft.startSeconds}
                onChange={(event) => updateDraft('startSeconds', event.target.value)}
              />
            </label>
            <label>
              End seconds
              <input
                type="number"
                min="0"
                step="0.01"
                value={draft.endSeconds}
                onChange={(event) => updateDraft('endSeconds', event.target.value)}
              />
            </label>
          </div>
        )}
        {cell.type === 'extract_frame' && (
          <div className="inspector-field-pair">
            <label>
              Frame
              <select
                value={draft.frameMode}
                onChange={(event) => updateDraft(
                  'frameMode',
                  event.target.value as CellFormDraft['frameMode'],
                )}
              >
                <option value="first">First</option>
                <option value="time">Time</option>
                <option value="last">Last</option>
              </select>
            </label>
            {draft.frameMode === 'time' && (
              <label>
                Timestamp seconds
                <input
                  type="number"
                  min="0"
                  step="0.01"
                  value={draft.timestampSeconds}
                  onChange={(event) => updateDraft(
                    'timestampSeconds',
                    event.target.value,
                  )}
                />
              </label>
            )}
          </div>
        )}
        {cell.type === 'splice' && draft.operation === 'splice_video' && (
          <label>
            Overlap seconds
            <input
              type="number"
              min="0"
              step="0.01"
              value={draft.overlap}
              onChange={(event) => updateDraft('overlap', event.target.value)}
            />
          </label>
        )}
        {generationCell && !draft.tool && !draft.model && (
          <span className="workspace-notice">
            No generation model matches the current inputs.
          </span>
        )}
        {generationCell && (
          <div className="inspector-generation-controls">
            <div className="inspector-generation-model">
              <label>
                Model
                <select
                  aria-label="Model"
                  value={selectedGenerationValue}
                  disabled={busy || compatibleActions.length === 0}
                  onChange={(event) => updateGenerationAction(event.target.value)}
                >
                  {!selectedGenerationAction && draft.tool && (
                    <option value={draft.tool}>
                      {draft.tool} · incompatible
                    </option>
                  )}
                  {!selectedGenerationValue && (
                    <option value="">No compatible models</option>
                  )}
                  {generationPickerActions.map((candidate) => {
                    const compatible = generationActionIsCompatible(
                      candidate,
                      connectedGenerationInputs,
                    )
                    const label = generationActionLabel(
                      candidate,
                    )
                    return (
                      <option key={candidate.id} value={candidate.id}>
                        {compatible ? label : `${label} · incompatible`}
                      </option>
                    )
                  })}
                </select>
              </label>
            </div>
            {(selectedGenerationAction?.inputContract.modes.length ?? 0) > 1
              || primaryGenerationControls.length > 0 ? (
                <div className="inspector-generation-primary">
                  {(selectedGenerationAction?.inputContract.modes.length ?? 0) > 1 && (
                    <label>
                      Type
                      <select
                        aria-label="Type"
                        value={effectiveGenerationMode}
                        disabled={busy || generationModeOptions.length === 0}
                        onChange={(event) => updateDraft(
                          'generationMode',
                          event.target.value,
                        )}
                      >
                        {generationModeOptions.map((mode) => (
                          <option key={mode.id} value={mode.id}>
                            {generationModeLabel(mode.id)}
                            {!compatibleModes.some((candidate) =>
                              candidate.id === mode.id)
                              ? ' · needs inputs'
                              : ''}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  {primaryGenerationControls.map((control) => (
                    <GenerationControlField
                      key={control.name}
                      control={control}
                      settings={draft.generationSettings}
                      busy={busy || saving}
                      onChange={(value) => updateGenerationSetting(
                        control.name,
                        value,
                      )}
                    />
                  ))}
                </div>
              ) : null}
            {advancedGenerationControls.length > 0 && (
              <details className="inspector-generation-options">
                <summary>Options</summary>
                <div className="inspector-generation-option-fields">
                  {advancedGenerationControls.map((control) => (
                    <GenerationControlField
                      key={control.name}
                      control={control}
                      settings={draft.generationSettings}
                      busy={busy || saving}
                      onChange={(value) => updateGenerationSetting(
                        control.name,
                        value,
                      )}
                    />
                  ))}
                </div>
              </details>
            )}
          </div>
        )}
        {generationCell && selectedGenerationValue && !generationCompatible && (
          <div className="inspector-generation-warning" role="status">
            <CircleAlert size={14} />
            <span>
              {!generationActionCompatible
                ? 'This model does not accept the current inputs. Choose a compatible model or change the connections.'
                : !generationModeCompatible
                  ? 'This generation type does not match the current inputs. Choose a compatible type or change the connections.'
                  : 'Complete the required generation settings before running.'}
            </span>
          </div>
        )}
        {generationCell && onPreviewPayload && (
          <AnalysisJsonDisclosure
            key={[
              cell.id,
              draft.tool,
              draft.prompt,
              effectiveGenerationMode,
              JSON.stringify(draft.generationSettings),
              ...edges
                .filter((edge) => edge.target === cell.id)
                .map((edge) => `${edge.source}:${edge.targetInput}`)
                .sort(),
            ].join(':')}
            className="inspector-payload-disclosure"
            label="Payload"
            summary={payloadSummary}
            ariaLabel={`Provider payload preview for ${notebookGridTag(cell.slot)}`}
            loadValue={() => onPreviewPayload(cell.id, {
              prompt: draft.prompt,
              provider: draft.provider,
              model: draft.model,
              operation: draft.operation,
              tool: draft.tool,
              inputs: generationInputsForDraft(
                cell,
                {
                  ...draft,
                  generationMode: effectiveGenerationMode,
                  generationSettings: payloadSettings,
                },
                allGenerationControls,
              ),
            })}
          />
        )}
        {dirty && (
          <div
            className={`inspector-dirty-notice${valid ? '' : ' invalid'}`}
            role="status"
          >
            <CircleAlert size={14} />
            <span>
              {valid
                ? generationCell
                  ? 'Changes apply when you generate'
                  : saveOnRun
                  ? 'Changes apply when this action runs'
                  : 'Unsaved changes'
                : generationCell
                  ? 'Check the generation type and required settings'
                  : saveOnRun
                  ? 'Check timing values before running'
                  : 'Check timing values before saving'}
            </span>
          </div>
        )}
        {!saveOnRun && !generationCell && (
          <button
            type="submit"
            className="inspector-save-button"
            disabled={busy || saving || !dirty || !valid}
          >
            <Save size={15} />
            <span>{saving ? 'Saving…' : 'Save changes'}</span>
          </button>
        )}
      </form>
      {runLabel && (action || generationCell) && (
        <section
          className={[
            'inspector-cell-actions',
            generationCell ? 'inspector-generation-actions' : '',
          ].filter(Boolean).join(' ')}
          aria-label="Primary cell action"
        >
          <button
            type="button"
            className="inspector-run-action"
            aria-busy={saveOnRun && saving}
            title={
              action?.disabled
                ? 'A run is already in progress for this cell'
                : generationCell && !generationCompatible
                  ? 'Check the generation type and required settings'
                : !saveOnRun && dirty
                  ? 'Save changes before running'
                  : undefined
            }
            onClick={() => {
              if (saveOnRun) {
                void saveAndRun()
                return
              }
              void onRun(cell.id)
            }}
            disabled={
              busy
              || saving
              || action?.disabled
              || !valid
              || (!saveOnRun && dirty)
            }
          >
            {saveOnRun && saving
              ? generationCell ? 'Generating…' : 'Applying…'
              : runLabel}
          </button>
        </section>
      )}
      {(status === 'error' || error) && (
        <section
          className="inspector-run-error"
          role="alert"
          aria-label="Cell run error"
        >
          <CircleAlert size={16} aria-hidden="true" />
          <div className="inspector-run-error-content">
            <div className="inspector-run-error-header">
              <strong>Run failed</strong>
              <button
                type="button"
                aria-label="Copy run error"
                title="Copy run error"
                onClick={() => void copyRunError()}
              >
                <span aria-live="polite">{copyLabel}</span>
              </button>
            </div>
            <p>{runError}</p>
          </div>
        </section>
      )}
      <CellCleanupActions
        cell={cell}
        edges={edges}
        busy={busy}
        clearing={clearing}
        deleting={deleting}
        onClearSlot={onClearSlot}
        onDelete={onDelete}
      />
    </div>
  )
}

export function NotebookCellInspector({
  notebookId,
  cell,
  cells,
  edges,
  asset,
  cellAssets,
  versionAssets,
  status,
  error,
  busy,
  clearing,
  deleting,
  sourceVisible,
  generationActions,
  onUpdate,
  onSetInput,
  onRun,
  onClearSlot,
  onDelete,
  onOpenFullscreen,
  onPreviewPayload,
}: NotebookCellInspectorProps) {
  if (sourceVisible) {
    return (
      <div className="inspector-body inspector-source-body">
        <DoltCellSource notebookId={notebookId} cell={cell} />
      </div>
    )
  }

  if (cell.type === 'analysis') {
    return (
      <AnalysisCellInspector
        cell={cell}
        cells={cells}
        edges={edges}
        asset={asset}
        cellAssets={cellAssets}
        versionAssets={versionAssets}
        busy={busy}
        clearing={clearing}
        deleting={deleting}
        onUpdate={onUpdate}
        onSetInput={onSetInput}
        onClearSlot={onClearSlot}
        onDelete={onDelete}
      />
    )
  }

  if (isPassiveOutputCell(cell)) {
    return (
      <MediaCellInspector
        cell={cell}
        cells={cells}
        edges={edges}
        asset={asset}
        cellAssets={cellAssets}
        versionAssets={versionAssets}
        busy={busy}
        clearing={clearing}
        deleting={deleting}
        onUpdate={onUpdate}
        onSetInput={onSetInput}
        onClearSlot={onClearSlot}
        onDelete={onDelete}
        onOpenFullscreen={onOpenFullscreen}
      />
    )
  }

  return (
    <ExecutableCellInspector
      cell={cell}
      cells={cells}
      edges={edges}
      asset={asset}
      cellAssets={cellAssets}
      status={status}
      error={error}
      busy={busy}
      clearing={clearing}
      deleting={deleting}
      onUpdate={onUpdate}
      onSetInput={onSetInput}
      onRun={onRun}
      onClearSlot={onClearSlot}
      onDelete={onDelete}
      onOpenFullscreen={onOpenFullscreen}
      onPreviewPayload={onPreviewPayload}
      generationActions={generationActions}
    />
  )
}
