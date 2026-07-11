import { memo, useContext } from 'react'
import { BaseEdge, type EdgeProps, type Edge, useStore } from '@xyflow/react'
import { trunkBusY, trunkStubPath, trunkSharedPath, trunkDot, type TrunkEdgeData } from './trunk-edges.js'
import { TrunkHoverContext } from './TrunkHoverContext.js'

export type TrunkEdgeType = Edge<TrunkEdgeData, 'trunk'>

export const TrunkEdge = memo(function TrunkEdge(props: EdgeProps<TrunkEdgeType>) {
  const { sourceX, sourceY, targetX, targetY, data } = props

  const { hoveredGroupId } = useContext(TrunkHoverContext)
  const isHovered = data ? hoveredGroupId === data.groupId : false

  const siblingXs = useStore(
    (state) => {
      if (!data?.isPrimary) return []
      return data.siblingIds.map((id) => {
        const node = state.nodeLookup.get(id)
        if (!node) return 0
        const x = node.internals?.positionAbsolute?.x ?? node.position.x
        const width = node.measured?.width ?? 300
        return x + width / 2
      })
    },
    (a, b) => a.join(',') === b.join(','),
  )

  if (!data) return null

  const busY = trunkBusY(targetY, data.staggerIndex)
  const coords = { sourceX, sourceY, targetX, targetY, busY }

  const stub = trunkStubPath(data.groupKind, coords)

  const baseClasses = ['vc-trunk']
  if (isHovered) baseClasses.push('is-hovered')

  return (
    <g className={baseClasses.join(' ')}>
      <BaseEdge path={stub} interactionWidth={18} {...props} />
      {data.isPrimary && (
        <PrimarySharedGeometry
          data={data}
          coords={coords}
          siblingXs={siblingXs}
          isHovered={isHovered}
        />
      )}
    </g>
  )
})

function PrimarySharedGeometry({
  data,
  coords,
  siblingXs,
  isHovered,
}: {
  data: TrunkEdgeData
  coords: { sourceX: number; sourceY: number; targetX: number; targetY: number; busY: number }
  siblingXs: number[]
  isHovered: boolean
}) {
  const shared = trunkSharedPath(data.groupKind, { ...coords, siblingXs })
  const dotCoords = trunkDot(data.groupKind, { ...coords, groupSize: data.groupSize })

  const classes = ['vc-trunk-shared']
  if (data.groupActive) classes.push('is-active')
  if (data.groupRunning) classes.push('is-running')
  if (isHovered) classes.push('is-hovered')

  return (
    <>
      <path className={classes.join(' ')} d={shared} fill="none" />
      <path
        className="react-flow__edge-interaction"
        d={shared}
        fill="none"
        strokeWidth={18}
        strokeOpacity={0}
      />
      {dotCoords && <circle className="vc-trunk-dot" cx={dotCoords.x} cy={dotCoords.y} r={3.5} />}
    </>
  )
}
