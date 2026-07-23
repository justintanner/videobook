import { Download, ExternalLink, Play } from 'lucide-react'
import type { BookCellData } from '@/videobook/project-book'

interface CellInspectorPreviewProps {
  cell: BookCellData
}

function cellRatio(cell: BookCellData): string | null {
  if (!cell.width || !cell.height) return null
  if (cell.width > cell.height) return '16:9'
  if (cell.width < cell.height) return '9:16'
  return '1:1'
}

export function CellInspectorPreview({ cell }: CellInspectorPreviewProps) {
  const previewUrl = cell.mediaUrl ?? cell.thumbnailUrl
  const ratio = cellRatio(cell)

  return (
    <section
      className="inspector-cell-preview"
      aria-label={`Selected ${cell.kind} cell contents`}
    >
      {previewUrl ? (
        <div className="inspector-cell-media">
          {cell.kind === 'video' && cell.mediaUrl ? (
            <video
              src={cell.mediaUrl}
              poster={cell.thumbnailUrl}
              controls
              playsInline
              preload="metadata"
            />
          ) : (
            <img src={previewUrl} alt={cell.slug} />
          )}
          {ratio && <span className="inspector-cell-ratio">{ratio}</span>}
        </div>
      ) : (
        <p className="inspector-cell-copy">
          {cell.prompt || cell.operation}
        </p>
      )}
      <footer className="inspector-cell-meta">
        <span>{cell.status}</span>
      </footer>
      {cell.mediaUrl && (
        <nav className="inspector-media-actions" aria-label="Media actions">
          <a
            href={cell.mediaUrl}
            target="_blank"
            rel="noreferrer"
          >
            {cell.kind === 'video'
              ? <Play size={14} />
              : <ExternalLink size={14} />}
            {cell.kind === 'video' ? 'Play media' : 'Open media'}
          </a>
          <a href={cell.mediaUrl} download>
            <Download size={14} />
            Download
          </a>
        </nav>
      )}
    </section>
  )
}
