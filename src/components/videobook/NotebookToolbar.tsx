import { BrushCleaning, Library, Plus } from 'lucide-react'
import { NotebookCellAddMenu } from '@/components/videobook/NotebookCellAddMenu'
import type { NotebookCellAddType } from '@/videobook/notebook-cell-add-menu'

type NotebookToolbarProps = {
  busy: boolean
  arrangeDisabled: boolean
  onAdd: (type: NotebookCellAddType) => void | Promise<void>
  onAddDragEnd: () => void
  onArrange: () => void | Promise<void>
  assetsOpen: boolean
  assetsDisabled: boolean
  onAssets: () => void
}

export function NotebookToolbar({
  busy,
  arrangeDisabled,
  onAdd,
  onAddDragEnd,
  onArrange,
  assetsOpen,
  assetsDisabled,
  onAssets,
}: NotebookToolbarProps) {
  return (
    <div className="canvas-toolbar" data-composer-focus="return" role="group" aria-label="Notebook canvas controls">
      <div className="canvas-primary-actions" role="group" aria-label="Notebook editing tools">
        <NotebookCellAddMenu disabled={busy} onAdd={onAdd} onDragEnd={onAddDragEnd} />
        <button
          type="button"
          className="canvas-auto-arrange canvas-quick-add"
          title="Add an image cell and pick from recent media"
          aria-label="Add image"
          disabled={busy}
          onClick={() => void onAdd('image')}
        >
          <Plus size={15} />
          <span>Image</span>
        </button>
        <button
          type="button"
          className="canvas-auto-arrange canvas-quick-add"
          title="Add a video cell and pick from recent media"
          aria-label="Add video"
          disabled={busy}
          onClick={() => void onAdd('video')}
        >
          <Plus size={15} />
          <span>Video</span>
        </button>
        <button
          type="button"
          className="canvas-auto-arrange"
          title="Clean up cells by workflow and media type"
          aria-label="Clean up notebook"
          disabled={arrangeDisabled}
          onClick={() => void onArrange()}
        >
          <BrushCleaning size={15} />
          <span>Clean</span>
        </button>
        <button
          type="button"
          className={assetsOpen ? 'canvas-auto-arrange active' : 'canvas-auto-arrange'}
          title="Assets"
          aria-label="Open Assets"
          aria-expanded={assetsOpen}
          disabled={assetsDisabled}
          onClick={onAssets}
        >
          <Library size={15} />
          <span>Assets</span>
        </button>
      </div>
    </div>
  )
}
