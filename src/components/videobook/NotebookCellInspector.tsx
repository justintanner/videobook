import { Maximize2, Trash2 } from 'lucide-react'
import { useState } from 'react'
import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import { doltCellRows } from '@/videobook/dolt-cell-source'
import {
  isNotebookMediaCellType,
  notebookAudioSummary,
  notebookCellActionPresentation,
  notebookCellStatusLabel,
  type NotebookAudioInfo,
} from '@/videobook/notebook-cell-presentation'

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
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onSetInput: (targetInput: string, sourceCellId: string | null) => Promise<void>
  onRun: (cellId: string) => Promise<void>
  onDelete: () => Promise<void>
  onOpenFullscreen: () => void
}

type MediaInspectorTab = 'preview' | 'inputs' | 'source'

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
          {rows.map((row) => (
            <tr key={row.column}>
              <th scope="row">{row.column}</th>
              <td>{row.type}</td>
              <td>
                <code className={row.value === null ? 'dolt-null' : undefined}>
                  {row.value === null ? 'NULL' : String(row.value)}
                </code>
              </td>
            </tr>
          ))}
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
  onUpdate,
}: {
  cell: NotebookCell
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
}) {
  return (
    <label className="inspector-slug-field">
      Slug
      <span>
        @
        <input defaultValue={cell.slug} onBlur={(event) => {
          const slug = event.target.value.trim()
          if (slug && slug !== cell.slug) void onUpdate({ slug })
        }} />
      </span>
    </label>
  )
}

function MediaCellInspector({
  notebookId,
  cell,
  cells,
  edges,
  asset,
  busy,
  onSetInput,
  onDelete,
  onOpenFullscreen,
}: Pick<
  NotebookCellInspectorProps,
  | 'notebookId'
  | 'cell'
  | 'cells'
  | 'edges'
  | 'asset'
  | 'busy'
  | 'onSetInput'
  | 'onDelete'
  | 'onOpenFullscreen'
>) {
  const [tab, setTab] = useState<MediaInspectorTab>('preview')

  return (
    <div className="inspector-body inspector-media-body">
      <h2 className="inspector-slug">@{cell.slug}</h2>
      <span className="workspace-notice">{cell.type.toUpperCase()}</span>
      <nav
        className="inspector-tabs"
        aria-label="Media cell inspector"
        role="tablist"
      >
        {(['preview', 'inputs', 'source'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            className={tab === value ? 'active' : undefined}
            aria-selected={tab === value}
            aria-controls={`${cell.id}-inspector-panel`}
            onClick={() => setTab(value)}
          >
            {value}
          </button>
        ))}
      </nav>
      <div
        id={`${cell.id}-inspector-panel`}
        className="inspector-tab-panel"
        role="tabpanel"
      >
        {tab === 'preview' && (
          asset ? (
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
          )
        )}
        {tab === 'inputs' && (
          <InputSources
            cell={cell}
            cells={cells}
            edges={edges}
            busy={busy}
            onSetInput={onSetInput}
          />
        )}
        {tab === 'source' && <DoltCellSource notebookId={notebookId} cell={cell} />}
      </div>
      <div className="record-card-actions inspector-media-actions">
        <button
          type="button"
          className="danger-button"
          onClick={() => void onDelete()}
          disabled={busy}
        >
          <Trash2 size={13} />Delete
        </button>
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
  onUpdate,
  onSetInput,
  onRun,
  onDelete,
  onOpenFullscreen,
}: NotebookCellInspectorProps) {
  if (isPassiveMediaCell(cell)) {
    return (
      <MediaCellInspector
        notebookId={notebookId}
        cell={cell}
        cells={cells}
        edges={edges}
        asset={asset}
        busy={busy}
        onSetInput={onSetInput}
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
      <h2 className="inspector-slug">@{cell.slug}</h2>
      <span className="workspace-notice">
        {cell.type.toUpperCase()}{statusLabel ? ` · ${statusLabel}` : ''}
      </span>
      {asset && previewCell && (
        <NotebookCellMedia
          asset={asset}
          slug={cell.slug}
          allowFullscreen={false}
          onOpenFullscreen={onOpenFullscreen}
        />
      )}
      <SlugField cell={cell} onUpdate={onUpdate} />
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
      <DoltCellSource notebookId={notebookId} cell={cell} />
      <div className="record-card-actions">
        {action && (
          <button type="button" onClick={() => void onRun(cell.id)} disabled={busy || action.disabled}>
            {action.label}
          </button>
        )}
        <button
          type="button"
          className="danger-button"
          onClick={() => void onDelete()}
          disabled={busy}
        >
          <Trash2 size={13} />Delete
        </button>
      </div>
    </div>
  )
}
