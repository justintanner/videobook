import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { AlertCircle, ImageIcon, Loader2, Video } from 'lucide-react'
import type { ConnectedMediaInput } from '../model'
import type { NotebookNodeData } from './nodeTypes'

function MediaInputThumb({ item }: { item: ConnectedMediaInput }) {
  const Icon = item.kind === 'video' ? Video : ImageIcon
  return (
    <span className="vc-node-input-thumb" title={item.label}>
      {item.thumbnailSrc
        ? <img src={item.thumbnailSrc} alt="" />
        : <Icon aria-hidden />}
    </span>
  )
}

function GenNodeComponent({ data, selected }: NodeProps) {
  const node = data as NotebookNodeData
  const { step } = node
  const Icon = step.type === 'video' ? Video : ImageIcon
  const model = typeof step.properties.model === 'string' && step.properties.model
    ? step.properties.model
    : 'choose model'
  const mediaInputs = node.mediaInputs ?? []
  return (
    <div className={`vc-node vc-node-gen vc-node-${step.type} ${selected ? 'vc-node-selected' : ''} ${node.invalidReason ? 'vc-node-invalid' : ''}`}>
      <Handle type="target" position={Position.Top} className="vc-node-handle" />
      {mediaInputs.length > 0 ? (
        <div className="vc-node-input-strip" aria-label="Connected media inputs">
          {mediaInputs.map((item) => (
            <MediaInputThumb key={item.sourceId} item={item} />
          ))}
        </div>
      ) : null}
      <div className="vc-node-hero">
        {node.thumbnailSrc ? <img src={node.thumbnailSrc} alt="" /> : <Icon />}
        <span className={`vc-node-status vc-node-status-${node.running ? 'running' : node.runState}`}>
          {node.running ? <Loader2 /> : node.error || node.runState === 'error' ? <AlertCircle /> : null}
        </span>
      </div>
      <div className="vc-node-meta">
        <span>{model}</span>
        {node.cost && <b>{node.cost}</b>}
      </div>
      <Handle type="source" position={Position.Bottom} className="vc-node-handle" />
    </div>
  )
}

export const GenNode = memo(GenNodeComponent)
