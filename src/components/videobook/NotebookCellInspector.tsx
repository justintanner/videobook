import { Check, CircleX, Maximize2, Pencil, Trash2, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import {
  doltCellDisplayValue,
  doltCellRows,
} from '@/videobook/dolt-cell-source'
import {
  isNotebookMediaCellType,
  notebookAudioSummary,
  notebookCellActionPresentation,
  notebookCellStatusLabel,
  type NotebookAudioInfo,
} from '@/videobook/notebook-cell-presentation'
import { RichJson } from './RichJson'

const localActions = {
  extract_audio: [{ operation: 'extract_audio', label: 'Extract audio', tool: 'ffmpeg' }],
  split_video: [{ operation: 'split_range', label: 'Split video', tool: 'ffmpeg' }],
  prompt: [{ operation: 'rewrite_prompt', label: 'Rewrite prompt', tool: 'rewrite_prompt' }],
  analyze: [{ operation: 'analyze_source', label: 'Analyze source', tool: 'kie_gemini_analysis' }],
  concat: [{ operation: 'concat_video', label: 'Concatenate videos', tool: 'ffmpeg' }],
  splice: [
    { operation: 'splice_video', label: 'Match or hard join', tool: 'ffmpeg' },
    { operation: 'smooth_scene_concat', label: 'Smooth crossfade', tool: 'ffmpeg' },
  ],
} as const

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
}

type NotebookCellInspectorProps = {
  notebookId: string
  cell: NotebookCell
  cells: NotebookCell[]
  edges: NotebookEdge[]
  asset: NotebookCellInspectorAsset | undefined
  status: string
  busy: boolean
  clearing: boolean
  deleting: boolean
  sourceVisible: boolean
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onSetInput: (targetInput: string, sourceCellId: string | null) => Promise<void>
  onRun: (cellId: string) => Promise<void>
  onClearSlot: () => Promise<void>
  onDelete: () => Promise<void>
  onOpenFullscreen: () => void
}

function isPassiveMediaCell(cell: NotebookCell): boolean {
  return cell.type === 'audio' || cell.type === 'image' || cell.type === 'video'
}

function mediaInputNames(cell: NotebookCell, edges: NotebookEdge[]): string[] {
  const connected = edges
    .filter((edge) => edge.target === cell.id)
    .map((edge) => edge.targetInput)
  const fallback = cell.type === 'image' ? 'segment' : 'media'
  return [...new Set([...connected, fallback])]
}

function compatibleSource(
  target: NotebookCell,
  targetInput: string,
  source: NotebookCell,
): boolean {
  if (source.id === target.id) return false
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
  const audioSummary = notebookAudioSummary({
    audioInfo: asset.audioInfo,
    durationSeconds: asset.duration,
    hasOutput: true,
    inputs: undefined,
  })

  if (!previewUrl) return null

  return (
    <section className="inspector-cell-preview" aria-label="Cell output media">
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
      {isAudio && <strong className="inspector-audio-summary">{audioSummary}</strong>}
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
            return (
              <tr key={row.column}>
                <th scope="row">{row.column}</th>
                <td>{row.type}</td>
                <td>
                  {displayValue.kind === 'json' ? (
                    <RichJson
                      value={displayValue.value}
                      ariaLabel={`${row.column} JSON`}
                    />
                  ) : (
                    <code className={displayValue.kind === 'null' ? 'dolt-null' : undefined}>
                      {displayValue.kind === 'null' ? 'NULL' : String(displayValue.value)}
                    </code>
                  )}
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
  onSetInput,
}: {
  cell: NotebookCell
  cells: NotebookCell[]
  edges: NotebookEdge[]
  busy: boolean
  onSetInput: (targetInput: string, sourceCellId: string | null) => Promise<void>
}) {
  const inputs = mediaInputNames(cell, edges)

  return (
    <section className="inspector-input-sources">
      <h3>Inputs</h3>
      <p>Select the upstream cell that owns each media input.</p>
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
      <span className="workspace-notice">
        Changing a source clears this preview until its producer is rerun.
      </span>
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
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
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

function ClearSlotButton({
  busy,
  canClear,
  clearing,
  onClearSlot,
}: {
  busy: boolean
  canClear: boolean
  clearing: boolean
  onClearSlot: () => Promise<void>
}) {
  return (
    <button
      type="button"
      className="inspector-clear-slot-button"
      aria-busy={clearing}
      onClick={() => void onClearSlot()}
      disabled={busy || clearing || !canClear}
    >
      <CircleX size={13} />
      <span>{clearing ? 'Clearing…' : 'Clear slot'}</span>
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
    <button
      type="button"
      className="danger-button inspector-delete-button"
      aria-busy={deleting}
      onClick={() => void onDelete()}
      disabled={busy}
    >
      <Trash2 size={13} />
      <span>{deleting ? 'Deleting…' : 'Delete'}</span>
    </button>
  )
}

function MediaCellInspector({
  cell,
  cells,
  edges,
  asset,
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

  return (
    <div className="inspector-body inspector-media-body">
      <div className="inspector-media-content">
        <SlugField cell={cell} busy={busy} onUpdate={onUpdate} />
        <span className="inspector-media-field-label">
          {cell.type.replaceAll('_', ' ').toUpperCase()}
        </span>
        {asset ? (
          <NotebookCellMedia
            asset={asset}
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
      </div>
      <div className="record-card-actions inspector-media-actions">
        <ClearSlotButton
          busy={busy}
          canClear={canClear}
          clearing={clearing}
          onClearSlot={onClearSlot}
        />
        <DeleteCellButton busy={busy} deleting={deleting} onDelete={onDelete} />
      </div>
    </div>
  )
}

export function NotebookCellInspector({
  notebookId,
  cell,
  cells,
  edges,
  asset,
  status,
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

  if (isPassiveMediaCell(cell)) {
    return (
      <MediaCellInspector
        cell={cell}
        cells={cells}
        edges={edges}
        asset={asset}
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

  const action = notebookCellActionPresentation(cell, status)
  const statusLabel = notebookCellStatusLabel(cell.type, status)
  const textCell = cell.type === 'prompt'
    || cell.type === 'analyze'
    || cell.type === 'generate_video'
    || cell.type === 'generate_image'
    || cell.type === 'generate_audio'
  const generationCell = cell.type === 'generate_video'
    || cell.type === 'generate_image'
    || cell.type === 'generate_audio'
  const previewCell = cell.type === 'character' || generationCell
  const actions = cell.type in localActions
    ? localActions[cell.type as keyof typeof localActions]
    : []

  return (
    <div className="inspector-body">
      <SlugField cell={cell} busy={busy} onUpdate={onUpdate} />
      {statusLabel && (
        <span className="workspace-notice inspector-cell-status">{statusLabel}</span>
      )}
      {asset && previewCell && (
        <NotebookCellMedia
          asset={asset}
          slug={cell.slug}
          allowFullscreen={false}
          onOpenFullscreen={onOpenFullscreen}
        />
      )}
      {textCell && (
        <label>
          Prompt
          <textarea defaultValue={cell.prompt ?? ''} rows={8} onBlur={(event) => {
            if (event.target.value !== (cell.prompt ?? '')) {
              void onUpdate({ prompt: event.target.value })
            }
          }} />
        </label>
      )}
      {actions.length > 0 && (
        <label>
          Action
          <select
            value={cell.operation ?? ''}
            onChange={(event) => {
              const nextAction = actions.find((candidate) =>
                candidate.operation === event.target.value)
              void onUpdate(nextAction
                ? {
                    operation: nextAction.operation,
                    tool: nextAction.tool,
                    provider: nextAction.operation === 'analyze_source'
                      ? 'kie'
                      : nextAction.operation === 'rewrite_prompt'
                        ? 'openai'
                        : 'local',
                  }
                : {
                    operation: undefined,
                    tool: undefined,
                    provider: undefined,
                  })
            }}
          >
            <option value="">No action</option>
            {actions.map((candidate) => (
              <option key={candidate.operation} value={candidate.operation}>
                {candidate.label}
              </option>
            ))}
          </select>
        </label>
      )}
      {cell.type === 'split_video' && (
        <div className="inspector-field-pair">
          <label>
            Start seconds
            <input
              type="number"
              min="0"
              step="0.01"
              defaultValue={Number(cell.inputs?.startSeconds ?? 0)}
              onBlur={(event) => void onUpdate({
                inputs: {
                  ...(cell.inputs ?? {}),
                  startSeconds: Number(event.target.value),
                },
              })}
            />
          </label>
          <label>
            End seconds
            <input
              type="number"
              min="0"
              step="0.01"
              defaultValue={Number(cell.inputs?.endSeconds ?? 0)}
              onBlur={(event) => void onUpdate({
                inputs: {
                  ...(cell.inputs ?? {}),
                  endSeconds: Number(event.target.value),
                },
              })}
            />
          </label>
        </div>
      )}
      {cell.type === 'splice' && cell.operation === 'splice_video' && (
        <label>
          Overlap seconds
          <input
            type="number"
            min="0"
            step="0.01"
            defaultValue={Number(cell.inputs?.overlap ?? 0)}
            onBlur={(event) => void onUpdate({
              inputs: {
                ...(cell.inputs ?? {}),
                overlap: Number(event.target.value),
              },
            })}
          />
        </label>
      )}
      {generationCell && !cell.tool && !cell.model && (
        <span className="workspace-notice">Choose a generation tool before running this cell.</span>
      )}
      {!isNotebookMediaCellType(cell.type) && (
        <>
          <label>
            Provider
            <input
              defaultValue={cell.provider ?? ''}
              placeholder="Provider"
              onBlur={(event) => {
                if (event.target.value !== (cell.provider ?? '')) {
                  void onUpdate({ provider: event.target.value || undefined })
                }
              }}
            />
          </label>
          <label>
            Model
            <input
              defaultValue={cell.model ?? ''}
              placeholder="Model"
              onBlur={(event) => {
                if (event.target.value !== (cell.model ?? '')) {
                  void onUpdate({ model: event.target.value || undefined })
                }
              }}
            />
          </label>
          <label>
            Operation
            <input
              defaultValue={cell.operation ?? ''}
              placeholder="Operation"
              onBlur={(event) => {
                if (event.target.value !== (cell.operation ?? '')) {
                  void onUpdate({ operation: event.target.value || undefined })
                }
              }}
            />
          </label>
          <label>
            Tool
            <input
              defaultValue={cell.tool ?? cell.model ?? ''}
              placeholder="Tool"
              onBlur={(event) => {
                if (event.target.value !== (cell.tool ?? cell.model ?? '')) {
                  void onUpdate({ tool: event.target.value || undefined })
                }
              }}
            />
          </label>
        </>
      )}
      <div className="record-card-actions">
        {action && (
          <button type="button" onClick={() => void onRun(cell.id)} disabled={busy || action.disabled}>
            {action.label}
          </button>
        )}
        <DeleteCellButton busy={busy} deleting={deleting} onDelete={onDelete} />
      </div>
    </div>
  )
}
