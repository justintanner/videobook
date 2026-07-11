import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { MessageSquareText } from 'lucide-react'
import type { NotebookNodeData } from './nodeTypes'

function PromptNodeComponent({ data, selected }: NodeProps) {
  const node = data as NotebookNodeData
  const text = typeof node.step.properties.text === 'string' ? node.step.properties.text : ''
  return (
    <div className={`vc-node vc-node-prompt ${selected ? 'vc-node-selected' : ''} ${node.invalidReason ? 'vc-node-invalid' : ''} ${node.routeState ? `vc-node-route-${node.routeState}` : ''}`}>
      <div className="vc-node-kicker"><span>Prompt</span><b>TXT</b></div>
      <div className="vc-node-prompt-icon"><MessageSquareText /></div>
      <p>{text || 'Write a prompt in the sidebar.'}</p>
      <Handle type="source" position={Position.Bottom} className="vc-node-handle" />
    </div>
  )
}

export const PromptNode = memo(PromptNodeComponent)
