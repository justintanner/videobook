import { ViewportPortal } from '@xyflow/react'
import {
  notebookGrid,
  notebookGridPosition,
  type NotebookGridMetrics,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'

interface NotebookGridBoardProps {
  metrics: NotebookGridMetrics
  previewSlot: NotebookGridSlot | null
  hiddenRows?: readonly number[]
}

export function NotebookGridBoard({
  metrics,
  previewSlot,
  hiddenRows = [],
}: NotebookGridBoardProps) {
  const previewPosition = previewSlot ? notebookGridPosition(previewSlot) : null
  const hidden = new Set(hiddenRows)
  const contentWidth = metrics.width - notebookGrid.originX * 2

  return (
    <ViewportPortal>
      <div
        className="notebook-grid-board"
        style={{
          width: contentWidth,
          height: metrics.height,
          transform: `translateX(${metrics.minColumn * notebookGrid.columnPitch}px)`,
        }}
      >
        {Array.from({ length: metrics.rowCount }, (_, row) => (
          hidden.has(row)
            ? null
            : Array.from({ length: metrics.columnCount }, (_, index) => {
                const column = metrics.minColumn + index
                return (
                  <span
                    className="notebook-grid-square"
                    key={`${row}:${column}`}
                    style={{
                      width: notebookGrid.squareSize,
                      height: notebookGrid.squareSize,
                      transform: `translate(${index * notebookGrid.columnPitch}px, ${notebookGrid.originY + row * notebookGrid.rowPitch}px)`,
                    }}
                  />
                )
              })
        ))}
        {previewPosition && (
          <div
            className="notebook-grid-preview"
            style={{
              width: notebookGrid.squareSize,
              height: notebookGrid.squareSize,
              transform: `translate(${previewPosition.x - metrics.minColumn * notebookGrid.columnPitch}px, ${previewPosition.y}px)`,
            }}
          />
        )}
      </div>
    </ViewportPortal>
  )
}
