import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { ImageIcon, Music, Video } from 'lucide-react'
import { assetSlugKind } from '../model'
import type { NotebookNodeData } from './nodeTypes'

function AssetNodeComponent({ data, selected }: NodeProps) {
  const node = data as NotebookNodeData
  const slug = typeof node.step.properties.slug === 'string' ? node.step.properties.slug : '@missing'
  const kind = assetSlugKind(slug)
  const Icon = kind === 'video' ? Video : kind === 'audio' ? Music : ImageIcon
  return (
    <div className={`vc-node vc-node-asset ${selected ? 'vc-node-selected' : ''} ${node.missing ? 'vc-node-missing' : ''}`}>
      {node.thumbnailSrc ? <img src={node.thumbnailSrc} alt="" /> : <Icon />}
      <span>{slug}</span>
      <Handle type="source" position={Position.Bottom} className="vc-node-handle" />
    </div>
  )
}

export const AssetNode = memo(AssetNodeComponent)
