import { memo } from 'react'
import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  useStore,
} from '@xyflow/react'
import {
  notebookBusRiverPath,
  notebookSourcePortOffsets,
  type NotebookBusRiverRoute,
} from '@/videobook/notebook-routing'
import { notebookGrid } from '@/videobook/notebook-grid'

type BusRiverEdgeType = Edge<NotebookBusRiverRoute, 'busRiver'>

interface BusRiverNodeBounds {
  sourceLeftX: number
  sourceRightX: number
  sourceBottomY: number
  targetCenterX: number
  targetLeftX: number
  targetTopY: number
  targetHeight: number
}

function nodeBoundsEqual(
  left: BusRiverNodeBounds | null,
  right: BusRiverNodeBounds | null,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return left.sourceLeftX === right.sourceLeftX
    && left.sourceRightX === right.sourceRightX
    && left.sourceBottomY === right.sourceBottomY
    && left.targetCenterX === right.targetCenterX
    && left.targetLeftX === right.targetLeftX
    && left.targetTopY === right.targetTopY
    && left.targetHeight === right.targetHeight
}

export const BusRiverEdge = memo(function BusRiverEdge(
  props: EdgeProps<BusRiverEdgeType>,
) {
  const { source, sourceX, sourceY, target, data } = props
  const bounds = useStore((state): BusRiverNodeBounds | null => {
    const sourceNode = state.nodeLookup.get(source)
    const targetNode = state.nodeLookup.get(target)
    if (!sourceNode || !targetNode) return null
    const sourcePosition = sourceNode.internals?.positionAbsolute
      ?? sourceNode.position
    const targetPosition = targetNode.internals?.positionAbsolute
      ?? targetNode.position
    const sourceWidth = sourceNode.measured?.width
      ?? notebookGrid.squareSize
    const sourceHeight = sourceNode.measured?.height
      ?? notebookGrid.squareSize
    const targetWidth = targetNode.measured?.width
      ?? notebookGrid.squareSize
    const targetHeight = targetNode.measured?.height
      ?? notebookGrid.squareSize
    return {
      sourceLeftX: sourcePosition.x,
      sourceRightX: sourcePosition.x + sourceWidth,
      sourceBottomY: sourcePosition.y + sourceHeight,
      targetCenterX: targetPosition.x + targetWidth / 2,
      targetLeftX: targetPosition.x,
      targetTopY: targetPosition.y,
      targetHeight,
    }
  }, nodeBoundsEqual)
  if (!data || !bounds) return null

  const targetPortOffset = notebookSourcePortOffsets[data.targetPortIndex]
    ?? notebookSourcePortOffsets[1]
  const targetX = data.targetSide === 'left'
    ? bounds.targetLeftX
    : bounds.targetCenterX
  const targetY = data.targetSide === 'left'
    ? bounds.targetTopY + bounds.targetHeight * targetPortOffset
    : bounds.targetTopY

  const path = notebookBusRiverPath(
    {
      sourceX,
      sourceY,
      targetX,
      targetY,
      ...bounds,
    },
    data,
  )

  return (
    <>
      <BaseEdge
        id={props.id}
        path={path}
        interactionWidth={18}
        style={props.style}
      />
      <circle
        className="bus-river-entry-dot"
        cx={targetX}
        cy={targetY}
        r={2.5}
      />
    </>
  )
})
