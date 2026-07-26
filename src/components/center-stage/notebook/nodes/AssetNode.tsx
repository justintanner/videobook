import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { ImageIcon, Music, User, Video } from 'lucide-react'
import type { NotebookNodeData } from './nodeTypes'

function AssetNodeComponent({ data, selected }: NodeProps) {
  const node = data as NotebookNodeData
  const slug = typeof node.step.properties.slug === 'string' ? node.step.properties.slug : '@missing'
  const kind = node.step.type
  const Icon = kind === 'video' ? Video : kind === 'audio' ? Music : kind === 'character' ? User : ImageIcon
  return (
    <div className={`vc-node vc-node-media vc-node-media-${kind} ${selected ? 'vc-node-selected' : ''} ${node.missing ? 'vc-node-missing' : ''} ${node.routeState ? `vc-node-route-${node.routeState}` : ''}`}>
      <div className="vc-node-kicker"><span><Icon aria-hidden /> {kind}</span><b>{kind.slice(0, 3)}</b></div>
      {node.thumbnailSrc ? <img src={node.thumbnailSrc} alt="" /> : <Icon />}
      <span>{slug}</span>
      <Handle type="source" position={Position.Bottom} className="vc-node-handle" />
    </div>
  )
}

export const AssetNode = memo(AssetNodeComponent)
