import { Trash2 } from 'lucide-react'
import type { NotebookCell } from 'videobook-engine'
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
  asset: NotebookCellInspectorAsset | undefined
  status: string
  busy: boolean
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
  onRun: (cellId: string) => Promise<void>
  onDelete: () => Promise<void>
}

function NotebookCellMedia({
  asset,
  title,
}: {
  asset: NotebookCellInspectorAsset
  title: string
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
            playsInline
            preload="auto"
          />
        ) : isAudio && mediaUrl ? (
          <audio key={mediaUrl} src={mediaUrl} controls preload="auto" />
        ) : (
          <img key={previewUrl} src={previewUrl} alt={title} />
        )}
        <span className="inspector-cell-ratio">{dimensions}</span>
      </div>
      {isAudio && <span className="workspace-notice">{audioSummary}</span>}
      {mediaUrl && (
        <div className="inspector-media-actions">
          <a href={mediaUrl} target="_blank" rel="noreferrer">Open output</a>
        </div>
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

export function NotebookCellInspector({
  notebookId,
  cell,
  asset,
  status,
  busy,
  onUpdate,
  onRun,
  onDelete,
}: NotebookCellInspectorProps) {
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
  const mediaCell = cell.type === 'audio'
    || cell.type === 'image'
    || cell.type === 'video'
    || cell.type === 'character'
    || generationCell
  const actions = cell.type in localActions
    ? localActions[cell.type as keyof typeof localActions]
    : []

  return (
    <div className="inspector-body">
      <h2 className="inspector-slug">{cell.title}</h2>
      <span className="workspace-notice">
        {cell.type.toUpperCase()}{statusLabel ? ` · ${statusLabel}` : ''}
      </span>
      {asset && mediaCell && <NotebookCellMedia asset={asset} title={cell.title} />}
      <label>
        Title
        <input defaultValue={cell.title} onBlur={(event) => {
          const title = event.target.value.trim()
          if (title && title !== cell.title) void onUpdate({ title })
        }} />
      </label>
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
              const action = actions.find((candidate) =>
                candidate.operation === event.target.value)
              void onUpdate(action
                ? {
                    operation: action.operation,
                    tool: action.tool,
                    provider: action.operation === 'analyze_source'
                      ? 'kie'
                      : action.operation === 'rewrite_prompt'
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
            {actions.map((action) => (
              <option key={action.operation} value={action.operation}>
                {action.label}
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
