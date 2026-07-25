import { ViewportPortal, type Node } from '@xyflow/react'
import type { NotebookGrid } from 'videobook-engine'
import type { NotebookCellData } from '@/videobook/notebook-draft'
import {
  notebookGrid,
  notebookGridMetrics,
  notebookGridPosition,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'

interface NotebookGridBoardProps {
  grid: NotebookGrid
  nodes: Array<Node<NotebookCellData>>
  previewSlot: NotebookGridSlot | null
}

export function NotebookGridBoard({
  grid,
  nodes,
  previewSlot,
}: NotebookGridBoardProps) {
  const metrics = notebookGridMetrics(
    nodes.map((node) => node.data.slot),
    grid.columns.length,
    previewSlot,
  )
  const previewPosition = previewSlot ? notebookGridPosition(previewSlot) : null
  const columns = Array.from(
    { length: metrics.columnCount },
    (_, index) => grid.columns[index] ?? { id: `column-${index + 1}` },
  )
  const columnHeight = metrics.height - notebookGrid.viewportGutter

  return (
    <ViewportPortal>
      <div
        className="notebook-grid-board"
        style={{ width: metrics.width, height: metrics.height }}
      >
        {columns.map((column, index) => (
          <div
            className="notebook-grid-column"
            key={`column:${column.id}`}
            style={{
              width: notebookGrid.squareSize,
              height: columnHeight,
              transform: `translateX(${notebookGrid.originX + index * notebookGrid.columnPitch}px)`,
            }}
          />
        ))}
        {columns.map((column, index) => (
          <span
            className="notebook-grid-header"
            key={`header:${column.id}`}
            style={{
              width: notebookGrid.squareSize,
              transform: `translateX(${notebookGrid.originX + index * notebookGrid.columnPitch}px)`,
            }}
            aria-label={column.label ?? `Column ${index + 1}`}
          >
            {column.label ?? ''}
          </span>
        ))}
        {Array.from({ length: metrics.rowCount }, (_, row) => (
          columns.map((column, columnIndex) => (
            <span
              className="notebook-grid-square"
              key={`${row}:${column.id}`}
              style={{
                width: notebookGrid.squareSize,
                height: notebookGrid.squareSize,
                transform: `translate(${notebookGrid.originX + columnIndex * notebookGrid.columnPitch}px, ${notebookGrid.originY + row * notebookGrid.rowPitch}px)`,
              }}
            />
          ))
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
