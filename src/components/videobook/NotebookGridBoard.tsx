import { ViewportPortal } from '@xyflow/react'
import {
  notebookGrid,
  notebookGridTag,
  notebookGridPosition,
  type NotebookGridMetrics,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'

interface NotebookGridBoardProps {
  metrics: NotebookGridMetrics
  previewSlot: NotebookGridSlot | null
}

export function NotebookGridBoard({
  metrics,
  previewSlot,
}: NotebookGridBoardProps) {
  const previewPosition = previewSlot ? notebookGridPosition(previewSlot) : null

  return (
    <ViewportPortal>
      <div
        className="notebook-grid-board"
        style={{
          width: metrics.width,
          height: metrics.height,
        }}
      >
        {Array.from({ length: metrics.rowCount }, (_, row) => (
          Array.from({ length: metrics.columnCount }, (_, index) => {
            const column = metrics.minColumn + index
            return (
              <span
                className="notebook-grid-square"
                key={`${row}:${column}`}
                style={{
                  width: notebookGrid.squareSize,
                  height: notebookGrid.squareSize,
                  transform: `translate(${notebookGrid.originX + index * notebookGrid.columnPitch}px, ${notebookGrid.originY + row * notebookGrid.rowPitch}px)`,
                }}
              >
                <span className="notebook-grid-square-label">
                  {notebookGridTag({ row, column })}
                </span>
              </span>
            )
          })
        ))}
        {previewPosition && (
          <div
            className="notebook-grid-preview"
            style={{
              width: notebookGrid.squareSize,
              height: notebookGrid.squareSize,
              transform: `translate(${previewPosition.x}px, ${previewPosition.y}px)`,
            }}
          />
        )}
      </div>
    </ViewportPortal>
  )
}
