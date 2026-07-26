import { memo } from 'react'
import {
  BaseEdge,
  type Edge,
  type EdgeProps,
  useStore,
} from '@xyflow/react'
import {
  notebookBusRiverPath,
  type NotebookBusRiverRoute,
} from '@/videobook/notebook-routing'
import { notebookGrid } from '@/videobook/notebook-grid'

export type BusRiverEdgeType = Edge<NotebookBusRiverRoute, 'busRiver'>

interface BusRiverNodeBounds {
  sourceLeftX: number
  sourceRightX: number
  sourceBottomY: number
  targetCenterX: number
  targetTopY: number
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
    && left.targetTopY === right.targetTopY
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
    return {
      sourceLeftX: sourcePosition.x,
      sourceRightX: sourcePosition.x + sourceWidth,
      sourceBottomY: sourcePosition.y + sourceHeight,
      targetCenterX: targetPosition.x + targetWidth / 2,
      targetTopY: targetPosition.y,
    }
  }, nodeBoundsEqual)
  if (!data || !bounds) return null

  const path = notebookBusRiverPath(
    {
      sourceX,
      sourceY,
      targetX: bounds.targetCenterX,
      targetY: bounds.targetTopY,
      ...bounds,
    },
    data,
  )

  return <BaseEdge path={path} interactionWidth={18} {...props} />
})
