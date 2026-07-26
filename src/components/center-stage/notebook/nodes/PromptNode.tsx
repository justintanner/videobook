import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { MessageSquareText, ScanSearch } from 'lucide-react'
import type { NotebookNodeData } from './nodeTypes'

function PromptNodeComponent({ data, selected }: NodeProps) {
  const node = data as NotebookNodeData
  const text = typeof node.step.properties.text === 'string' ? node.step.properties.text : ''
  const Icon = node.step.type === 'analyze' ? ScanSearch : MessageSquareText
  return (
    <div className={`vc-node vc-node-text vc-node-${node.step.type} ${selected ? 'vc-node-selected' : ''} ${node.invalidReason ? 'vc-node-invalid' : ''} ${node.routeState ? `vc-node-route-${node.routeState}` : ''}`}>
      {node.step.type === 'analyze' ? <Handle type="target" position={Position.Top} className="vc-node-handle" /> : null}
      <div className="vc-node-kicker"><span><Icon aria-hidden /> {node.step.type}</span><b>TXT</b></div>
      <p>{text || `Configure ${node.step.type} in the sidebar.`}</p>
      <Handle type="source" position={Position.Bottom} className="vc-node-handle" />
    </div>
  )
}

export const PromptNode = memo(PromptNodeComponent)
