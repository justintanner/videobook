import { AudioWaveform, Braces, Image, Sparkles, Video } from 'lucide-react'
import { ViewportPortal, type Viewport } from '@xyflow/react'
import {
  notebookGrid,
  notebookGridTag,
  notebookGridPosition,
  notebookGridSlotKey,
  type NotebookGridMetrics,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'
import type {
  NotebookLaneFamily,
  NotebookLaneSection,
} from '@/videobook/notebook-lane-policy'

interface NotebookGridBoardProps {
  sections: readonly NotebookLaneSection[]
  metrics: NotebookGridMetrics
  occupiedSlots: readonly NotebookGridSlot[]
  previewSlot: NotebookGridSlot | null
  mediaDropActive: boolean
  mediaDropSlot: NotebookGridSlot | null
}

interface NotebookLaneCaptionsProps {
  sections: readonly NotebookLaneSection[]
  viewport: Viewport
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

function laneCaptionStyle(
  section: NotebookLaneSection,
  viewport: Viewport,
) {
  return {
    top: (notebookGrid.originY + section.startRow * notebookGrid.rowPitch)
      * viewport.zoom + viewport.y + 8,
  }
}

export function NotebookLaneCaptions({
  sections,
  viewport,
}: NotebookLaneCaptionsProps) {
  return (
    <div className="notebook-lane-captions">
      {sections.map((section) => {
        const family = section.family ?? 'mixed'
        return (
          <span
            className={`notebook-lane-caption notebook-lane-caption-${family}`}
            data-lane-caption={section.caption}
            data-lane-family={family}
            data-lane-kind={section.kind}
            data-lane-start-row={section.startRow}
            key={`caption-${section.startRow}-${family}`}
            role="heading"
            aria-level={2}
            aria-label={`${section.caption} lane`}
            title={section.caption}
            style={laneCaptionStyle(section, viewport)}
          >
            {laneIcon(section.family)}
            <span className="notebook-lane-caption-text" aria-hidden="true">
              {section.kind === 'mixed' ? 'Mixed' : section.caption}
            </span>
          </span>
        )
      })}
    </div>
  )
}

export function NotebookGridBoard({
  sections,
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
