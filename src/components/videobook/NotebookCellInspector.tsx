import { Trash2 } from 'lucide-react'
import type { NotebookCell } from 'videobook-engine'
import { doltCellRows } from '@/videobook/dolt-cell-source'

export type NotebookCellInspectorAsset = {
  artifactId: string
  id: string
  type: string
  mediaUrl: string | null
  thumbnailUrl: string | null
  width: number | null
  height: number | null
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

const RUNNABLE_TYPES = new Set([
  'source',
  'analysis',
  'split',
  'audio',
  'frame',
  'image',
  'video',
  'sequence',
  'export',
])

const PROMPT_TYPES = new Set([
  'prompt',
  'image',
  'video',
  'analysis',
])

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
  const canRun = RUNNABLE_TYPES.has(cell.type)

  return (
    <div className="inspector-body">
      <h2 className="inspector-slug">{cell.title}</h2>
      <span className="workspace-notice">{cell.type.toUpperCase()} · {status}</span>
      {asset && <NotebookCellMedia asset={asset} title={cell.title} />}
      <label>
        Title
        <input defaultValue={cell.title} onBlur={(event) => {
          const title = event.target.value.trim()
          if (title && title !== cell.title) void onUpdate({ title })
        }} />
      </label>
      {PROMPT_TYPES.has(cell.type) && (
        <label>
          Prompt
          <textarea defaultValue={cell.prompt ?? ''} rows={8} onBlur={(event) => {
            if (event.target.value !== (cell.prompt ?? '')) {
              void onUpdate({ prompt: event.target.value })
            }
          }} />
        </label>
      )}
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
      <DoltCellSource notebookId={notebookId} cell={cell} />
      <div className="record-card-actions">
        {canRun && (
          <button type="button" onClick={() => void onRun(cell.id)} disabled={busy}>
            Run cell
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
