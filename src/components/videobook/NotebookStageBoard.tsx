import { ViewportPortal, type Node } from '@xyflow/react'
import type { NotebookCellData } from '@/videobook/notebook-draft'
import {
  notebookGrid,
  notebookGridMetrics,
  notebookGridPosition,
  type NotebookGridSlot,
} from '@/videobook/notebook-grid'

interface NotebookStageBoardProps {
  nodes: Array<Node<NotebookCellData>>
  previewSlot: NotebookGridSlot | null
  labels?: readonly string[]
  featureLanes?: readonly NotebookFeatureLane[]
}

export interface NotebookFeatureLane {
  id: string
  label: string
  feature: string
  startColumn: number
  columnSpan: number
}

function stageLabel(stage: number, labels: readonly string[]): string {
  return labels[stage] || `STAGE ${String(stage + 1).padStart(2, '0')}`
}

export function NotebookStageBoard({
  nodes,
  previewSlot,
  labels = [],
  featureLanes = [],
}: NotebookStageBoardProps) {
  const metrics = notebookGridMetrics(
    nodes.map((node) => node.position),
    previewSlot,
  )
  const previewPosition = previewSlot ? notebookGridPosition(previewSlot) : null

  return (
    <ViewportPortal>
      <div
        className="notebook-stage-board"
        style={{ width: metrics.width, height: metrics.height }}
        aria-hidden
      >
        {featureLanes.map((lane) => (
          <div
            className="notebook-feature-lane"
            key={lane.id}
            style={{
              left: notebookGrid.originX + lane.startColumn * notebookGrid.columnPitch,
              width: lane.columnSpan * notebookGrid.columnPitch
                - (notebookGrid.columnPitch - notebookGrid.columnWidth),
              height: metrics.height,
            }}
          >
            <span>{lane.label}</span>
            <small>{lane.feature}</small>
          </div>
        ))}
        {Array.from({ length: metrics.stageCount }, (_, stage) => (
          <div
            className={`notebook-stage-row ${previewSlot?.stage === stage ? 'active' : ''}`}
            key={stage}
            style={{
              width: metrics.width,
              height: notebookGrid.stageHeight,
              transform: `translateY(${notebookGrid.originY + stage * notebookGrid.stagePitch - notebookGrid.stageHeadroom}px)`,
            }}
          >
            <span className="notebook-stage-label">{stageLabel(stage, labels)}</span>
            {Array.from({ length: metrics.columnCount }, (_, column) => (
              <span
                className="notebook-stage-column"
                key={column}
                style={{
                  left: notebookGrid.originX + column * notebookGrid.columnPitch,
                  width: notebookGrid.columnWidth,
                }}
              />
            ))}
          </div>
        ))}
        {previewPosition && (
          <div
            className="notebook-stage-preview"
            style={{
              width: notebookGrid.cellWidth,
              height: notebookGrid.cellHeight,
              transform: `translate(${previewPosition.x}px, ${previewPosition.y}px)`,
            }}
          />
        )}
      </div>
    </ViewportPortal>
  )
}
