import {
  Braces,
  Check,
  CircleAlert,
  CircleX,
  Layers2,
  Maximize2,
  Pencil,
  Save,
  X,
} from 'lucide-react'
import { Fragment, useEffect, useRef, useState } from 'react'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import {
  doltCellDisplayValue,
  doltCellRows,
} from '@/videobook/dolt-cell-source'
import {
  formatMediaTime,
  isNotebookMediaCellType,
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
import { RichJson } from './RichJson'

const actionCellTypes = new Set<NotebookCell['type']>([
  'extract_audio',
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
] as const satisfies readonly (keyof CellFormDraft)[]

function draftNumber(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value)
    ? String(value)
    : '0'
}

function cellFormDraft(cell: NotebookCell): CellFormDraft {
  return {
    prompt: cell.prompt ?? '',
    provider: cell.provider ?? '',
    model: cell.model ?? '',
    operation: cell.operation ?? '',
    tool: cell.tool ?? '',
    startSeconds: draftNumber(cell.inputs?.startSeconds),
    endSeconds: draftNumber(cell.inputs?.endSeconds),
    overlap: draftNumber(cell.inputs?.overlap),
  }
}

function cellFormIsDirty(cell: NotebookCell, draft: CellFormDraft): boolean {
  const persisted = cellFormDraft(cell)
  return cellFormDraftFields.some((field) => draft[field] !== persisted[field])
}

function validTimingValue(value: string): boolean {
  if (!value.trim()) return false
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed >= 0
}

function cellFormIsValid(cell: NotebookCell, draft: CellFormDraft): boolean {
  if (cell.type === 'split_video') {
    return validTimingValue(draft.startSeconds)
      && validTimingValue(draft.endSeconds)
  }
  if (cell.type === 'splice' && draft.operation === 'splice_video') {
    return validTimingValue(draft.overlap)
  }
  return true
}

function cellFormPatch(
  cell: NotebookCell,
  draft: CellFormDraft,
): Record<string, unknown> {
  const persisted = cellFormDraft(cell)
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
  versionAssets?: readonly NotebookCellInspectorAsset[]
  status: string
  error: string | null
  busy: boolean
  clearing: boolean
  deleting: boolean
  sourceVisible: boolean
  onUpdate: NotebookCellUpdate
  onSetInput: (targetInput: string, sourceCellId: string | null) => Promise<void>
  onRun: (cellId: string) => Promise<void>
  onClearSlot: () => Promise<void>
  onDelete: () => Promise<void>
  onOpenFullscreen: () => void
}

function isPassiveOutputCell(cell: NotebookCell): boolean {
  return cell.type === 'audio'
    || cell.type === 'image'
    || cell.type === 'video'
    || cell.type === 'analysis'
}

function defaultInputNames(cell: NotebookCell): string[] {
  if (cell.type === 'extract_audio') return ['video']
  if (cell.type === 'split_video') return ['video', 'analysis']
  if (cell.type === 'analysis') return ['result']
  if (cell.type === 'image') return ['segment']
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
  const dimensions = asset.width && asset.height
    ? `${asset.width}×${asset.height}`
    : asset.type.toUpperCase()
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
        {!isAudio && <span className="inspector-cell-ratio">{dimensions}</span>}
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

function InputSources({
  cell,
  cells,
  edges,
  busy,
  showHints = true,
  onSetInput,
}: {
  cell: NotebookCell
  cells: NotebookCell[]
  edges: NotebookEdge[]
  busy: boolean
  showHints?: boolean
  onSetInput: (targetInput: string, sourceCellId: string | null) => Promise<void>
}) {
  const inputs = cellInputNames(cell, edges)

  if (inputs.length === 0) return null

  return (
    <section className="inspector-input-sources">
      <h3>Inputs</h3>
      {showHints && <p>Select the upstream cell that supplies each input.</p>}
      {inputs.map((input) => {
        const edge = edges.find((candidate) =>
          candidate.target === cell.id && candidate.targetInput === input)
        const candidates = cells
          .filter((candidate) =>
            compatibleSource(cell, input, candidate) || candidate.id === edge?.source)
          .sort((left, right) => left.slug.localeCompare(right.slug))
        return (
          <label key={input}>
            <span>{input.replaceAll('_', ' ')}</span>
            <select
              value={edge?.source ?? ''}
              disabled={busy}
              onChange={(event) => {
                void onSetInput(input, event.target.value || null)
              }}
            >
              <option value="">No upstream source</option>
              {candidates.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  @{candidate.slug} · {candidate.type.replaceAll('_', ' ')}
                </option>
              ))}
            </select>
          </label>
        )
      })}
      {showHints && (
        <span className="workspace-notice">
          Changing a source clears this preview until its producer is rerun.
        </span>
      )}
    </section>
  )
}

function SlugField({
  cell,
  busy,
  onUpdate,
}: {
  cell: NotebookCell
  busy: boolean
  onUpdate: NotebookCellInspectorProps['onUpdate']
}) {
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [draft, setDraft] = useState(cell.slug)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [editing])

  const beginEditing = () => {
    if (editing || busy || saving) return
    setDraft(cell.slug)
    setEditing(true)
  }
  const cancel = () => {
    setDraft(cell.slug)
    setEditing(false)
  }
  const save = async () => {
    const slug = draft.trim()
    if (!slug || slug === cell.slug) {
      cancel()
      return
    }
    setSaving(true)
    try {
      await onUpdate({ slug })
      setEditing(false)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="inspector-slug-field">
      <label htmlFor={`inspector-slug-${cell.id}`}>Slug</label>
      <form
        className={`inspector-slug-control${editing ? ' editing' : ''}`}
        aria-busy={saving}
        onSubmit={(event) => {
          event.preventDefault()
          void save()
        }}
      >
        <span className="inspector-slug-prefix" aria-hidden="true">@</span>
        <input
          ref={inputRef}
          id={`inspector-slug-${cell.id}`}
          value={editing ? draft : cell.slug}
          readOnly={!editing}
          title={editing ? undefined : 'Click to edit slug'}
          autoComplete="off"
          spellCheck={false}
          disabled={busy || saving}
          onClick={beginEditing}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key !== 'Escape') return
            event.preventDefault()
            cancel()
          }}
        />
        {editing ? (
          <>
            <button
              type="submit"
              className="inspector-slug-action inspector-slug-save"
              aria-label="Save slug"
              title="Save slug"
              disabled={busy || saving || !draft.trim()}
            >
              <Check size={16} />
            </button>
            <button
              type="button"
              className="inspector-slug-action"
              aria-label="Cancel slug edit"
              title="Cancel slug edit"
              disabled={busy || saving}
              onClick={cancel}
            >
              <X size={16} />
            </button>
          </>
        ) : (
          <button
            type="button"
            className="inspector-slug-action"
            aria-label="Edit slug"
            title="Edit slug"
            disabled={busy}
            onClick={beginEditing}
          >
            <Pencil size={15} />
          </button>
        )}
      </form>
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

function ClearCellButton({
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
      className="danger-button inspector-clear-cell-button"
      label="Clear cell"
      pendingLabel="Clearing…"
      busy={busy}
      pending={deleting}
      onClear={onDelete}
    />
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
  versionAssets,
  busy,
  clearing,
  deleting,
  onUpdate,
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
  const canClear = Boolean(cell.outputArtifactId)
    || edges.some((edge) => edge.target === cell.id)
  const audioVersionArtifactIds = cell.type === 'audio'
    ? notebookOutputVersionArtifactIds(cell.inputs, cell.outputArtifactId)
    : []
  const audioVersionKey = audioVersionArtifactIds.join(':')
  const currentAudioVersionArtifactId = cell.outputArtifactId
    ?? audioVersionArtifactIds.at(-1)
    ?? ''
  const [audioVersionSelection, setAudioVersionSelection] = useState<{
    artifactId: string
    cellId: string
    currentArtifactId: string
    versionKey: string
  } | null>(null)
  const selectedAudioVersionArtifactId = (
    audioVersionSelection?.cellId === cell.id
    && audioVersionSelection.currentArtifactId === currentAudioVersionArtifactId
    && audioVersionSelection.versionKey === audioVersionKey
  )
    ? audioVersionSelection.artifactId
    : currentAudioVersionArtifactId
  const audioVersionAssetById = new Map(
    (versionAssets ?? []).map((versionAsset) => [
      versionAsset.artifactId,
      versionAsset,
    ]),
  )
  if (asset) audioVersionAssetById.set(asset.artifactId, asset)
  const selectedVersionAvailable = audioVersionAssetById.has(
    selectedAudioVersionArtifactId,
  )
  const effectiveAudioVersionArtifactId = (
    audioVersionArtifactIds.includes(selectedAudioVersionArtifactId)
    && selectedVersionAvailable
  )
    ? selectedAudioVersionArtifactId
    : currentAudioVersionArtifactId
  const previewAsset = cell.type === 'audio'
    ? audioVersionAssetById.get(effectiveAudioVersionArtifactId) ?? asset
    : asset
  const availableAudioVersionArtifactIds = new Set(audioVersionAssetById.keys())
  const selectAudioVersion = (artifactId: string) => {
    setAudioVersionSelection({
      artifactId,
      cellId: cell.id,
      currentArtifactId: currentAudioVersionArtifactId,
      versionKey: audioVersionKey,
    })
  }

  return (
    <div className="inspector-body inspector-media-body">
      <div className="inspector-media-content">
        <SlugField cell={cell} busy={busy} onUpdate={onUpdate} />
        <span className="inspector-media-field-label">
          {cell.type.replaceAll('_', ' ').toUpperCase()}
        </span>
        {audioVersionArtifactIds.length > 1 && previewAsset && (
          <OutputVersionSelector
            artifactIds={audioVersionArtifactIds}
            availableArtifactIds={availableAudioVersionArtifactIds}
            currentArtifactId={cell.outputArtifactId}
            selectedArtifactId={effectiveAudioVersionArtifactId}
            outputLabel="Audio"
            onSelect={selectAudioVersion}
          />
        )}
        {previewAsset ? (
          <NotebookCellMedia
            asset={previewAsset}
            slug={cell.slug}
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
          onSetInput={onSetInput}
        />
        <section
          className="inspector-cell-actions inspector-compact-actions"
          aria-label="Cell actions"
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
          <ClearCellButton busy={busy} deleting={deleting} onDelete={onDelete} />
        </section>
      </div>
    </div>
  )
}

function AnalysisJsonDisclosure({
  label,
  value,
  loadValue,
  ariaLabel,
}: {
  label: string
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
      className="inspector-analysis-json-disclosure"
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
  asset,
  versionAssets,
  busy,
  deleting,
  onUpdate,
  onDelete,
}: Pick<
  NotebookCellInspectorProps,
  | 'cell'
  | 'asset'
  | 'versionAssets'
  | 'busy'
  | 'deleting'
  | 'onUpdate'
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
        <SlugField cell={cell} busy={busy} onUpdate={onUpdate} />
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
        <section
          className="inspector-cell-actions inspector-compact-actions"
          aria-label="Cell actions"
        >
          <ClearCellButton busy={busy} deleting={deleting} onDelete={onDelete} />
        </section>
      </div>
    </div>
  )
}

function ExecutableCellInspector({
  cell,
  cells,
  edges,
  asset,
  status,
  error,
  busy,
  deleting,
  onUpdate,
  onSetInput,
  onRun,
  onDelete,
  onOpenFullscreen,
}: Pick<
  NotebookCellInspectorProps,
  | 'cell'
  | 'cells'
  | 'edges'
  | 'asset'
  | 'status'
  | 'error'
  | 'busy'
  | 'deleting'
  | 'onUpdate'
  | 'onSetInput'
  | 'onRun'
  | 'onDelete'
  | 'onOpenFullscreen'
>) {
  const [draft, setDraft] = useState(() => cellFormDraft(cell))
  const [saving, setSaving] = useState(false)
  const [copyResult, setCopyResult] = useState<{
    error: string
    state: 'copied' | 'failed'
  } | null>(null)
  const action = notebookCellActionPresentation(cell, status)
  const textCell = cell.type === 'prompt'
    || cell.type === 'analyze'
    || cell.type === 'generate_video'
    || cell.type === 'generate_image'
    || cell.type === 'generate_audio'
  const generationCell = cell.type === 'generate_video'
    || cell.type === 'generate_image'
    || cell.type === 'generate_audio'
  const previewCell = cell.type === 'character' || generationCell
  const actionCell = isActionCellType(cell.type)
  const dirty = cellFormIsDirty(cell, draft)
  const valid = cellFormIsValid(cell, draft)
  const runLabel = action
    ? notebookCellInspectorActionLabel(cell.type, action.label)
    : null
  const saveOnRun = actionCell && Boolean(runLabel)
  const runError = error
    ?? 'This action failed, but no error details were recorded.'
  const copyState = copyResult?.error === runError ? copyResult.state : 'idle'
  const copyLabel = copyState === 'copied'
    ? 'Copied'
    : copyState === 'failed'
      ? 'Retry copy'
      : 'Copy'

  const updateDraft = (field: keyof CellFormDraft, value: string) => {
    setDraft((current) => ({ ...current, [field]: value }))
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
      await onUpdate(cellFormPatch(cell, draft))
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
        patch: cellFormPatch(cell, draft),
        onUpdate,
        onRun,
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="inspector-body inspector-executable-body">
      <SlugField cell={cell} busy={busy} onUpdate={onUpdate} />
      {status === 'error' && (
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
      {asset && previewCell && (
        <NotebookCellMedia
          asset={asset}
          slug={cell.slug}
          allowFullscreen={false}
          onOpenFullscreen={onOpenFullscreen}
        />
      )}
      <InputSources
        cell={cell}
        cells={cells}
        edges={edges}
        busy={busy}
        showHints={cell.type !== 'analyze'}
        onSetInput={onSetInput}
      />
      <form
        className="inspector-cell-form"
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
            Choose a generation tool before running this cell.
          </span>
        )}
        {!isNotebookMediaCellType(cell.type) && !actionCell && (
          <>
            <label>
              Provider
              <input
                value={draft.provider}
                placeholder="Provider"
                onChange={(event) => updateDraft('provider', event.target.value)}
              />
            </label>
            <label>
              Model
              <input
                value={draft.model}
                placeholder="Model"
                onChange={(event) => updateDraft('model', event.target.value)}
              />
            </label>
            <label>
              Operation
              <input
                value={draft.operation}
                placeholder="Operation"
                onChange={(event) => updateDraft('operation', event.target.value)}
              />
            </label>
            <label>
              Tool
              <input
                value={draft.tool}
                placeholder="Tool"
                onChange={(event) => updateDraft('tool', event.target.value)}
              />
            </label>
          </>
        )}
        {dirty && (
          <div
            className={`inspector-dirty-notice${valid ? '' : ' invalid'}`}
            role="status"
          >
            <CircleAlert size={14} />
            <span>
              {valid
                ? saveOnRun
                  ? 'Changes apply when this action runs'
                  : 'Unsaved changes'
                : saveOnRun
                  ? 'Check timing values before running'
                  : 'Check timing values before saving'}
            </span>
          </div>
        )}
        {!saveOnRun && (
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
      <section className="inspector-cell-actions" aria-label="Cell actions">
        {action && runLabel && (
          <button
            type="button"
            className="inspector-run-action"
            aria-busy={saveOnRun && saving}
            title={!saveOnRun && dirty ? 'Save changes before running' : undefined}
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
              || action.disabled
              || !valid
              || (!saveOnRun && dirty)
            }
          >
            {saveOnRun && saving ? 'Applying…' : runLabel}
          </button>
        )}
        <ClearCellButton busy={busy} deleting={deleting} onDelete={onDelete} />
      </section>
    </div>
  )
}

export function NotebookCellInspector({
  notebookId,
  cell,
  cells,
  edges,
  asset,
  versionAssets,
  status,
  error,
  busy,
  clearing,
  deleting,
  sourceVisible,
  onUpdate,
  onSetInput,
  onRun,
  onClearSlot,
  onDelete,
  onOpenFullscreen,
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
        asset={asset}
        versionAssets={versionAssets}
        busy={busy}
        deleting={deleting}
        onUpdate={onUpdate}
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
      status={status}
      error={error}
      busy={busy}
      deleting={deleting}
      onUpdate={onUpdate}
      onSetInput={onSetInput}
      onRun={onRun}
      onDelete={onDelete}
      onOpenFullscreen={onOpenFullscreen}
    />
  )
}
