import { AudioWaveform, Braces, Image, Sparkles, Video } from 'lucide-react'
import { ViewportPortal } from '@xyflow/react'
import {
  notebookGrid,
  notebookGridTag,
  notebookGridPosition,
  notebookGridSlotKey,
  type NotebookGridMetrics,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'
import {
  groupNotebookLaneSections,
  summarizeNotebookLaneRows,
  type NotebookLaneCell,
  type NotebookLaneFamily,
  type NotebookLaneSection,
} from '@/videobook/notebook-lane-policy'

interface NotebookGridBoardProps {
  cells: readonly NotebookLaneCell[]
  metrics: NotebookGridMetrics
  occupiedSlots: readonly NotebookGridSlot[]
  previewSlot: NotebookGridSlot | null
  mediaDropActive: boolean
  mediaDropSlot: NotebookGridSlot | null
}

function laneIcon(family: NotebookLaneFamily | null) {
  if (family === 'image') return <Image size={11} strokeWidth={2.2} aria-hidden="true" />
  if (family === 'gen') return <Sparkles size={11} strokeWidth={2.2} aria-hidden="true" />
  if (family === 'video') return <Video size={11} strokeWidth={2.2} aria-hidden="true" />
  if (family === 'audio') return <AudioWaveform size={11} strokeWidth={2.2} aria-hidden="true" />
  if (family === 'work') return <Braces size={11} strokeWidth={2.2} aria-hidden="true" />
  return null
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

function firstEmptySlotInSection(
  section: NotebookLaneSection,
  occupiedSlotKeys: ReadonlySet<string>,
): NotebookGridSlot | null {
  for (let row = section.startRow; row < section.startRow + section.rowCount; row += 1) {
    for (let column = 0; column < notebookGrid.columnCount; column += 1) {
      const slot = { row, column }
      if (!occupiedSlotKeys.has(notebookGridSlotKey(slot))) return slot
    }
  }
  return null
}

function laneCaptionStyle(
  section: NotebookLaneSection,
  occupiedSlotKeys: ReadonlySet<string>,
) {
  const empty = firstEmptySlotInSection(section, occupiedSlotKeys)
  if (empty && (section.startRow === 0 || empty.column <= 4)) {
    return {
      transform: `translate(${notebookGrid.originX + empty.column * notebookGrid.columnPitch + 10}px, ${notebookGrid.originY + empty.row * notebookGrid.rowPitch + 28}px)`,
    }
  }
  const top = section.startRow === 0
    ? notebookGrid.originY + notebookGrid.squareSize + 8
    : notebookGrid.originY + section.startRow * notebookGrid.rowPitch - 22
  return {
    transform: `translate(${notebookGrid.originX + 10}px, ${top}px)`,
  }
}

export function NotebookGridBoard({
  cells,
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
  const laneSections = groupNotebookLaneSections(
    summarizeNotebookLaneRows(cells, metrics.rowCount),
  )

  return (
    <ViewportPortal>
      <div
        className="notebook-grid-board"
        style={{
          width: metrics.width,
          height: metrics.height,
        }}
      >
        {laneSections.map((section) => {
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
        {laneSections.map((section) => {
          const family = section.family ?? 'mixed'
          return (
            <span
              className={`notebook-lane-caption notebook-lane-caption-${family}`}
              data-lane-caption={section.caption}
              data-lane-family={family}
              data-lane-kind={section.kind}
              data-lane-start-row={section.startRow}
              key={`caption-${section.startRow}-${family}`}
              style={laneCaptionStyle(section, occupiedSlotKeys)}
            >
              {laneIcon(section.family)}
              <span>{section.caption}</span>
            </span>
          )
        })}
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
