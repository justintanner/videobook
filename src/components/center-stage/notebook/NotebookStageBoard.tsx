import { useMemo } from 'react'
import { ImageIcon, MessageSquareText, Video, View } from 'lucide-react'
import { ViewportPortal } from '@xyflow/react'
import {
  NOTEBOOK_TRACK_ORIGIN_X,
  NOTEBOOK_TRACK_ORIGIN_Y,
  NOTEBOOK_TRACK_ROW_PITCH,
  NOTEBOOK_TRACK_SLOT_PITCH,
  NOTEBOOK_TRACK_SLOT_WIDTH,
  notebookNodeSizes,
  notebookTrackLayout,
  type NotebookDropTarget,
} from './model'
import type { NotebookPlanDefinition } from './types'

export interface NotebookDropPreview extends NotebookDropTarget {
  type: 'prompt' | 'image' | 'video'
}

interface NotebookStageBoardProps {
  definition: NotebookPlanDefinition
  selectedStepId: string | null
  preview: NotebookDropPreview | null
}

const previewIcons = {
  prompt: MessageSquareText,
  image: ImageIcon,
  video: Video,
}

function stageCode(depth: number): string {
  return String(depth + 1).padStart(2, '0')
}

export function NotebookStageBoard({
  definition,
  selectedStepId,
  preview,
}: NotebookStageBoardProps) {
  const layout = useMemo(() => notebookTrackLayout(definition), [definition])
  const selectedDepth = selectedStepId ? layout.depths.get(selectedStepId) : undefined
  const maxDepth = Math.max(
    0,
    layout.rows.at(-1)?.depth ?? 0,
    preview?.depth ?? 0,
  )
  const rowCount = maxDepth + 2
  const maxSlots = Math.max(
    4,
    ...layout.rows.map((row) => row.stepIds.length + 1),
    preview ? preview.slot + 2 : 0,
  )
  const boardWidth = Math.max(1120, NOTEBOOK_TRACK_ORIGIN_X * 2 + maxSlots * NOTEBOOK_TRACK_SLOT_PITCH)
  const boardHeight = NOTEBOOK_TRACK_ORIGIN_Y + rowCount * NOTEBOOK_TRACK_ROW_PITCH
  const PreviewIcon = preview ? previewIcons[preview.type] : View
  const parent = preview?.parentId
    ? definition.sequence.find((step) => step.id === preview.parentId) ?? null
    : null
  const parentPosition = parent ? layout.positions.get(parent.id) : null
  const sourceX = parent && parentPosition
    ? parentPosition.x + notebookNodeSizes[parent.type].width / 2
    : 0
  const sourceY = parent && parentPosition
    ? parentPosition.y + notebookNodeSizes[parent.type].height
    : 0
  const targetX = preview ? preview.position.x + notebookNodeSizes[preview.type].width / 2 : 0
  const targetY = preview?.position.y ?? 0
  const curveY = sourceY + (targetY - sourceY) / 2

  return (
    <>
      <ViewportPortal>
        <div className="vc-notebook-stage-board" style={{ width: boardWidth, height: boardHeight }} aria-hidden>
          {Array.from({ length: rowCount }, (_, depth) => {
            const row = layout.rows.find((candidate) => candidate.depth === depth)
            const active = selectedDepth === depth || preview?.depth === depth
            return (
              <div
                className={`vc-notebook-stage-row ${active ? 'vc-notebook-stage-row-active' : ''}`}
                key={depth}
                style={{
                  width: boardWidth,
                  transform: `translateY(${NOTEBOOK_TRACK_ORIGIN_Y + depth * NOTEBOOK_TRACK_ROW_PITCH - 32}px)`,
                }}
              >
                <div className="vc-notebook-stage-label" style={{ left: NOTEBOOK_TRACK_ORIGIN_X }}>
                  <span>Stage</span>
                  <b>{stageCode(depth)}</b>
                  <em>{depth === 0 ? 'Ingress' : row?.stepIds.length ? 'Linked' : 'Next'}</em>
                </div>
                <div className="vc-notebook-stage-rail" />
                {Array.from({ length: maxSlots }, (_, slot) => (
                  <span
                    className="vc-notebook-stage-slot"
                    key={slot}
                    style={{
                      left: NOTEBOOK_TRACK_ORIGIN_X + slot * NOTEBOOK_TRACK_SLOT_PITCH,
                      width: NOTEBOOK_TRACK_SLOT_WIDTH,
                    }}
                  />
                ))}
              </div>
            )
          })}
        </div>
      </ViewportPortal>
      {preview ? (
        <ViewportPortal>
          <div className="vc-notebook-drop-preview-layer" style={{ width: boardWidth, height: boardHeight }} aria-hidden>
            {parent && parentPosition ? (
              <svg className="vc-notebook-drop-link" width={boardWidth} height={boardHeight}>
                <path d={`M ${sourceX} ${sourceY} C ${sourceX} ${curveY}, ${targetX} ${curveY}, ${targetX} ${targetY}`} />
              </svg>
            ) : null}
            <div
              className={`vc-notebook-drop-card vc-notebook-drop-card-${preview.type}`}
              style={{
                width: notebookNodeSizes[preview.type].width,
                height: notebookNodeSizes[preview.type].height,
                transform: `translate(${preview.position.x}px, ${preview.position.y}px)`,
              }}
            >
              <PreviewIcon />
              <span>{preview.parentId ? 'Connect & add' : 'Add unlinked'}</span>
            </div>
          </div>
        </ViewportPortal>
      ) : null}
    </>
  )
}
