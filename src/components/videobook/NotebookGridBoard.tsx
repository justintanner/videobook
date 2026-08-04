import { ViewportPortal } from '@xyflow/react'
import {
  notebookGrid,
  notebookGridTag,
  notebookGridPosition,
  notebookGridSlotKey,
  type NotebookGridMetrics,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'

interface NotebookGridBoardProps {
  metrics: NotebookGridMetrics
  occupiedSlots: readonly NotebookGridSlot[]
  previewSlot: NotebookGridSlot | null
  mediaDropActive: boolean
  mediaDropSlot: NotebookGridSlot | null
}

export function NotebookGridBoard({
  metrics,
  occupiedSlots,
  previewSlot,
  mediaDropActive,
  mediaDropSlot,
}: NotebookGridBoardProps) {
  const previewPosition = previewSlot ? notebookGridPosition(previewSlot) : null
  const occupiedSlotKeys = new Set(occupiedSlots.map(notebookGridSlotKey))
  const mediaDropSlotKey = mediaDropSlot
    ? notebookGridSlotKey(mediaDropSlot)
    : null

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
            const slot = { row, column }
            const slotKey = notebookGridSlotKey(slot)
            const mediaDropzone = mediaDropActive && !occupiedSlotKeys.has(slotKey)
            const mediaDropTarget = mediaDropzone && slotKey === mediaDropSlotKey
            const className = `notebook-grid-square${mediaDropzone
              ? ' notebook-grid-square-dropzone'
              : ''}${mediaDropTarget
              ? ' notebook-grid-square-drop-target'
              : ''}`
            return (
              <span
                className={className}
                key={slotKey}
                style={{
                  width: notebookGrid.squareSize,
                  height: notebookGrid.squareSize,
                  transform: `translate(${notebookGrid.originX + index * notebookGrid.columnPitch}px, ${notebookGrid.originY + row * notebookGrid.rowPitch}px)`,
                }}
              >
                <span className="notebook-grid-square-label">
                  {notebookGridTag(slot)}
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
