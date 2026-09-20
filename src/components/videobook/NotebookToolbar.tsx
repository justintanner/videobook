import { Ellipsis, LayoutGrid, Trash2, X, ZoomIn, ZoomOut } from 'lucide-react'
import { NotebookCellAddMenu } from '@/components/videobook/NotebookCellAddMenu'
import type { NotebookCellAddType } from '@/videobook/notebook-cell-add-menu'
import { notebookGrid } from '@/videobook/notebook-grid'

type NotebookToolbarProps = {
  zoom: number
  fitting: boolean
  busy: boolean
  arrangeDisabled: boolean
  selectedCount: number
  activeAddress: string | null
  onAdd: (type: NotebookCellAddType) => void | Promise<void>
  onAddDragEnd: () => void
  onArrange: () => void | Promise<void>
  onAdjustZoom: (change: number) => void
  onResetZoom: () => void
  onDeleteSelection: () => void | Promise<void>
  onClearSelection: () => void
  onSelectionActions?: () => void
}

export function NotebookToolbar({
  zoom,
  fitting,
  busy,
  arrangeDisabled,
  selectedCount,
  activeAddress,
  onAdd,
  onAddDragEnd,
  onArrange,
  onAdjustZoom,
  onResetZoom,
  onDeleteSelection,
  onClearSelection,
  onSelectionActions,
}: NotebookToolbarProps) {
  const deleteLabel = `Delete ${selectedCount} selected ${selectedCount === 1 ? 'cell' : 'cells'}`

  return (
    <div className="canvas-toolbar" data-composer-focus="return" role="group" aria-label="Notebook canvas controls">
      <div className="canvas-primary-actions" role="group" aria-label="Notebook editing tools">
        <NotebookCellAddMenu disabled={busy} onAdd={onAdd} onDragEnd={onAddDragEnd} />
        <button
          type="button"
          className="canvas-auto-arrange"
          title="Arrange cells into Images, Gen, Videos, Audio, and Work lanes"
          aria-label="Auto-arrange notebook"
          disabled={arrangeDisabled}
          onClick={() => void onArrange()}
        >
          <LayoutGrid size={15} />
          <span>Arrange</span>
        </button>
      </div>
      <div className="canvas-zoom-panel" role="group" aria-label="Notebook zoom controls">
        <button
          type="button"
          title="Zoom out"
          aria-label="Zoom out"
          disabled={zoom <= notebookGrid.minimumZoom}
          onClick={() => onAdjustZoom(-notebookGrid.zoomStep)}
        >
          <ZoomOut size={15} />
        </button>
        <button
          type="button"
          className="canvas-zoom-level"
          title={`Fit grid to width (${Math.round(zoom * 100)}%)`}
          aria-label="Fit grid to width"
          aria-pressed={fitting}
          onClick={onResetZoom}
        >
          {fitting ? 'Fit' : `${Math.round(zoom * 100)}%`}
        </button>
        <button
          type="button"
          title="Zoom in"
          aria-label="Zoom in"
          disabled={zoom >= notebookGrid.maximumZoom}
          onClick={() => onAdjustZoom(notebookGrid.zoomStep)}
        >
          <ZoomIn size={15} />
        </button>
      </div>
      {selectedCount > 0 && (
        <div className="canvas-selection-actions" role="group" aria-label="Notebook selection actions">
          <span
            className="canvas-selection-count"
            title="Shift-click cells or drag across the canvas to select more"
          >
            <strong>{selectedCount}</strong><span> selected</span>
          </span>
          {selectedCount > 1 && activeAddress && <code>{activeAddress} active</code>}
          {onSelectionActions && <button type="button" className="canvas-clear-selection" title="Selection actions" aria-label="Selection actions" data-workspace-action-surface="selection-menu" onClick={onSelectionActions}><Ellipsis size={14} /></button>}
          <button
            type="button"
            className="canvas-delete-selection"
            title={deleteLabel}
            aria-label={deleteLabel}
            aria-keyshortcuts="Delete Backspace"
            disabled={busy}
            onClick={() => void onDeleteSelection()}
          >
            <Trash2 size={14} />
            <span>Delete</span>
          </button>
          <button
            type="button"
            className="canvas-clear-selection"
            title="Clear selection"
            aria-label="Clear selection"
            onClick={onClearSelection}
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  )
}
