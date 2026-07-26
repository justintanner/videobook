import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { Merge, Scissors, Split } from 'lucide-react'
import type { NotebookNodeData } from './nodeTypes'

function PrimitiveNodeComponent({ data, selected }: NodeProps) {
  const node = data as NotebookNodeData
  const { step } = node
  const Icon = step.type === 'concat' ? Merge : step.type === 'splice' ? Scissors : Split
  return (
    <div className={`vc-node vc-node-${step.type} ${selected ? 'vc-node-selected' : ''} ${node.routeState ? `vc-node-route-${node.routeState}` : ''}`}>
      <Handle type="target" position={Position.Top} className="vc-node-handle" />
      <div className="vc-node-kicker"><span><Icon aria-hidden /> {step.type}</span><b>{step.type.slice(0, 3)}</b></div>
      <p>{step.name}</p>
      <Handle type="source" position={Position.Bottom} className="vc-node-handle" />
    </div>
  )
}

export const PrimitiveNode = memo(PrimitiveNodeComponent)
