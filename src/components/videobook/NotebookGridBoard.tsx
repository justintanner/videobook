import { ViewportPortal } from '@xyflow/react'
import {
  notebookGrid,
  notebookGridAddress,
  notebookGridTag,
  notebookGridPosition,
  notebookGridSlotKey,
  type NotebookGridMetrics,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'
import type { NotebookReviewRole } from '@/videobook/notebook-review-focus'
import type { NotebookLaneSection } from '@/videobook/notebook-lane-policy'

interface NotebookGridBoardProps {
  sections: readonly NotebookLaneSection[]
  metrics: NotebookGridMetrics
  occupiedSlots: readonly NotebookGridSlot[]
  previewSlot: NotebookGridSlot | null
  mediaDropActive: boolean
  mediaDropSlot: NotebookGridSlot | null
  // What an open review is about, by grid address. A target with no cell in it
  // yet is marked here, on the empty square itself.
  reviewRoles: ReadonlyMap<string, NotebookReviewRole>
}

function laneBandStyle(section: NotebookLaneSection) {
  const width = notebookGrid.columnCount * notebookGrid.columnPitch - notebookGrid.gap
  const height = section.rowCount * notebookGrid.rowPitch - notebookGrid.gap
  return {
    width,
    height,
    transform: `translate(${notebookGrid.originX}px, ${notebookGrid.originY + section.startRow * notebookGrid.rowPitch}px)`,
  }
}

export function NotebookGridBoard({
  sections,
  metrics,
  occupiedSlots,
  previewSlot,
  mediaDropActive,
  mediaDropSlot,
  reviewRoles,
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
        {sections.map((section) => {
          const family = section.family ?? 'mixed'
          return (
            <div
              className={`notebook-lane notebook-lane-${family}${section.kind === 'starter' ? ' notebook-lane-starter' : ''}${section.kind === 'mixed' ? ' notebook-lane-mixed' : ''}`}
              data-lane-caption={section.caption}
              data-lane-family={family}
              data-lane-kind={section.kind}
              data-lane-row-count={section.rowCount}
              data-lane-start-row={section.startRow}
              key={`lane-${section.startRow}-${family}`}
              style={laneBandStyle(section)}
            />
          )
        })}
        {Array.from({ length: metrics.rowCount }, (_, row) => (
          Array.from({ length: metrics.columnCount }, (_, index) => {
            const column = metrics.minColumn + index
            const slot = { row, column }
            const slotKey = notebookGridSlotKey(slot)
            const mediaDropzone = mediaDropActive && !occupiedSlotKeys.has(slotKey)
            const mediaDropTarget = mediaDropzone && slotKey === mediaDropSlotKey
            const reviewRole = occupiedSlotKeys.has(slotKey)
              ? undefined
              : reviewRoles.get(notebookGridAddress(slot))
            const className = `notebook-grid-square${mediaDropzone
              ? ' notebook-grid-square-dropzone'
              : ''}${mediaDropTarget
              ? ' notebook-grid-square-drop-target'
              : ''}${reviewRole
              ? ` notebook-grid-square-review notebook-review-${reviewRole}`
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
