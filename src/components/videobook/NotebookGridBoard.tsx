import { ViewportPortal } from '@xyflow/react'
import { History } from 'lucide-react'
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
import type { NotebookRoundHeader } from '@/videobook/notebook-round-headers'
import { generationPromptSegments } from '@/videobook/output-generation'

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
  roundHeaders: readonly NotebookRoundHeader[]
}

// How far a lane band reaches past its squares, so a cell never sits flush
// against the band's edge. Under half the gap, so stacked lanes stay apart.
const LANE_BAND_INSET = 10

function laneBandStyle(section: NotebookLaneSection, cellHeight: number) {
  const rowPitch = cellHeight + notebookGrid.gap
  const width = notebookGrid.columnCount * notebookGrid.columnPitch - notebookGrid.gap
  const height = section.rowCount * rowPitch - notebookGrid.gap
  const x = notebookGrid.originX - LANE_BAND_INSET
  const y = notebookGrid.originY + section.startRow * rowPitch - LANE_BAND_INSET
  return {
    width: width + LANE_BAND_INSET * 2,
    height: height + LANE_BAND_INSET * 2,
    transform: `translate(${x}px, ${y}px)`,
  }
}

function RoundPromptText({ prompt }: { prompt: string }) {
  let start = 0
  return generationPromptSegments(prompt).map((segment) => {
    const key = start
    start += segment.text.length
    return segment.token
      ? <span key={key} className="notebook-round-header-token">{segment.text}</span>
      : <span key={key}>{segment.text}</span>
  })
}

function RoundHeaderChange({ header }: { header: NotebookRoundHeader }) {
  const { change } = header
  if (change.kind === 'edited') {
    return (
      <ul className="notebook-round-header-diff">
        {change.removed.map((text, index) => (
          <li key={`removed-${index}`} className="notebook-round-header-removed">
            <span aria-hidden="true">−</span>
            <s><span className="sr-only">Removed </span>{text}</s>
          </li>
        ))}
        {change.added.map((text, index) => (
          <li key={`added-${index}`} className="notebook-round-header-added">
            <span aria-hidden="true">+</span>
            <span><span className="sr-only">Added </span>{text}</span>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <>
      {change.kind === 'rewritten' && <span className="notebook-round-header-rewritten">Rewritten</span>}
      <p className="notebook-round-header-prompt"><RoundPromptText prompt={header.prompt} /></p>
    </>
  )
}

function RoundHeaderTile({ header, cellHeight }: { header: NotebookRoundHeader; cellHeight: number }) {
  const position = notebookGridPosition(header.slot, cellHeight)
  const takes = header.takeCount === 1 ? '1 take' : `${header.takeCount} takes`
  return (
    <section
      className="notebook-round-header"
      aria-label={`Prompt version ${header.version}, ${takes}`}
      data-round-version={header.version}
      style={{
        width: notebookGrid.cellWidth,
        height: cellHeight,
        transform: `translate(${position.x}px, ${position.y}px)`,
      }}
    >
      <header className="notebook-round-header-title">
        <History aria-hidden="true" />
        <span>Prompt v{header.version}</span>
        <span className="notebook-round-header-takes">{takes}</span>
      </header>
      <RoundHeaderChange header={header} />
    </section>
  )
}

export function NotebookGridBoard({
  sections,
  metrics,
  occupiedSlots,
  previewSlot,
  mediaDropActive,
  mediaDropSlot,
  reviewRoles,
  roundHeaders,
}: NotebookGridBoardProps) {
  const previewPosition = previewSlot ? notebookGridPosition(previewSlot, metrics.cellHeight) : null
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
              style={laneBandStyle(section, metrics.cellHeight)}
            />
          )
        })}
        {Array.from({ length: metrics.rowCount }, (_, row) => (
          Array.from({ length: metrics.columnCount }, (_, index) => {
            const column = metrics.minColumn + index
            const slot = { row, column }
            const slotKey = notebookGridSlotKey(slot)
            const occupied = occupiedSlotKeys.has(slotKey)
            const mediaDropzone = mediaDropActive && !occupied
            const mediaDropTarget = mediaDropzone && slotKey === mediaDropSlotKey
            const reviewRole = occupied
              ? undefined
              : reviewRoles.get(notebookGridAddress(slot))
            // The square that opens a run of empty ones is the only one
            // labelled at rest; the rest read their address from this one.
            const runStart = !occupied && (
              index === 0
              || occupiedSlotKeys.has(notebookGridSlotKey({ row, column: column - 1 }))
            )
            const className = `notebook-grid-square${runStart
              ? ' notebook-grid-square-run-start'
              : ''}${mediaDropzone
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
                  width: notebookGrid.cellWidth,
                  height: metrics.cellHeight,
                  transform: `translate(${notebookGrid.originX + index * notebookGrid.columnPitch}px, ${notebookGrid.originY + row * (metrics.cellHeight + notebookGrid.gap)}px)`,
                }}
              >
                <span className="notebook-grid-square-label">
                  {notebookGridTag(slot)}
                </span>
              </span>
            )
          })
        ))}
        {roundHeaders.map((header) => (
          <RoundHeaderTile
            key={`${header.generatorId}-${header.version}`}
            header={header}
            cellHeight={metrics.cellHeight}
          />
        ))}
        {previewPosition && (
          <div
            className="notebook-grid-preview"
            style={{
              width: notebookGrid.cellWidth,
              height: metrics.cellHeight,
              transform: `translate(${previewPosition.x}px, ${previewPosition.y}px)`,
            }}
          />
        )}
      </div>
    </ViewportPortal>
  )
}
