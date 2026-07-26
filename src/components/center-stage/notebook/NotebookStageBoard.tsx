import { useMemo } from 'react'
import { Clapperboard, ImageIcon, ListFilter, MessageSquareText, Video, View, Music, User } from 'lucide-react'
import { ViewportPortal } from '@xyflow/react'
import {
  NOTEBOOK_STAGE_BAND_HEIGHT,
  NOTEBOOK_STAGE_BAND_HEADROOM,
  NOTEBOOK_STAGE_RAIL_WIDTH,
  NOTEBOOK_TRACK_ORIGIN_X,
  NOTEBOOK_TRACK_ORIGIN_Y,
  NOTEBOOK_TRACK_ROW_PITCH,
  NOTEBOOK_TRACK_SLOT_PITCH,
  NOTEBOOK_TRACK_SLOT_WIDTH,
  notebookNodeSizes,
  notebookStageCount,
  notebookTrackLayout,
  stageBoardMetrics,
  type NotebookDropTarget,
} from './model'
import type { NotebookPlanDefinition, NotebookStepType } from './types'

export interface NotebookDropPreview extends NotebookDropTarget {
  type: NotebookStepType
  assetKind?: 'image' | 'video' | 'audio' | 'character' | null
}

interface NotebookStageBoardProps {
  definition: NotebookPlanDefinition
  selectedStepId: string | null
  preview: NotebookDropPreview | null
  onAddStage: () => void
}

const previewIcons: Record<NotebookStepType, typeof View> = {
  audio: Music,
  image: ImageIcon,
  video: Video,
  character: User,
  prompt: MessageSquareText,
  analyze: View,
  split: ListFilter,
  generate_video: Clapperboard,
  generate_image: ImageIcon,
  generate_audio: Music,
  concat: Clapperboard,
  splice: ListFilter,
}

function stageCode(depth: number): string {
  return String(depth + 1).padStart(2, '0')
}

export function NotebookStageBoard({
  definition,
  selectedStepId,
  preview,
  onAddStage,
}: NotebookStageBoardProps) {
  const layout = useMemo(() => notebookTrackLayout(definition), [definition])
  const selectedDepth = selectedStepId ? layout.depths.get(selectedStepId) : undefined
  const stageCount = notebookStageCount(definition)
  const metrics = stageBoardMetrics(layout, preview, stageCount)
  const rowCount = metrics.rowCount
  const maxSlots = metrics.maxSlots
  const boardWidth = metrics.width
  const boardHeight = metrics.height
  const PreviewIcon = preview?.assetKind
    ? (preview.assetKind === 'image' ? ImageIcon : preview.assetKind === 'video' ? Video : preview.assetKind === 'audio' ? Music : User)
    : (preview ? previewIcons[preview.type] : View)
  const parent = preview?.parentId
    ? definition.sequence.find((step) => step.id === preview.parentId) ?? null
    : null
  const parentPosition = parent ? layout.positions.get(parent.id) : null
  const sourceX = parent && parentPosition
    ? parentPosition.x + notebookNodeSizes[parent.type].width / 2
    : 0
  const sourceY = parent && parentPosition
    ? parentPosition.y + (preview?.assetKind ? 0 : notebookNodeSizes[parent.type].height)
    : 0
  const targetX = preview ? preview.position.x + notebookNodeSizes[preview.type].width / 2 : 0
  const targetY = preview ? preview.position.y + (preview.assetKind ? notebookNodeSizes[preview.type].height : 0) : 0

  return (
    <>
      <ViewportPortal>
        <div className="vc-notebook-stage-board" style={{ width: boardWidth, height: boardHeight }} aria-hidden>
          {Array.from({ length: rowCount }, (_, depth) => {
            const active = selectedDepth === depth || preview?.depth === depth
            return (
              <div
                className={`vc-notebook-stage-row ${active ? 'vc-notebook-stage-row-active' : ''}`}
                key={depth}
                style={{
                  width: boardWidth,
                  height: NOTEBOOK_STAGE_BAND_HEIGHT,
                  transform: `translateY(${NOTEBOOK_TRACK_ORIGIN_Y + depth * NOTEBOOK_TRACK_ROW_PITCH - NOTEBOOK_STAGE_BAND_HEADROOM}px)`,
                }}
              >
                <div className="vc-notebook-stage-label" style={{ width: NOTEBOOK_STAGE_RAIL_WIDTH }}>
                  <b>{`Stage ${stageCode(depth)}`}</b>
                </div>
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
        <button
          className="vc-notebook-add-stage nopan"
          onClick={onAddStage}
          style={{
            width: boardWidth,
            height: 56,
            transform: `translateY(${NOTEBOOK_TRACK_ORIGIN_Y + rowCount * NOTEBOOK_TRACK_ROW_PITCH - NOTEBOOK_STAGE_BAND_HEADROOM}px)`,
          }}
        >
          + Add stage {stageCode(rowCount)}
        </button>
      </ViewportPortal>
      {preview ? (
        <ViewportPortal>
          <div className="vc-notebook-drop-preview-layer" style={{ width: boardWidth, height: boardHeight }} aria-hidden>
            {parent && parentPosition ? (
              <svg className="vc-notebook-drop-link" width={boardWidth} height={boardHeight}>
                <path d={`M ${sourceX} ${sourceY} V ${targetY - 56} H ${targetX} V ${targetY}`} />
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
