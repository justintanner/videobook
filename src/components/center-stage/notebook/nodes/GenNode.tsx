import { memo } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { AlertCircle, ImageIcon, Loader2, Video, FileQuestion } from 'lucide-react'
import type { ConnectedMediaInput, GenRunOutput } from '../model'
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

function GenOutputThumb({
  output,
  onPromote,
}: {
  output: GenRunOutput
  onPromote: () => void
}) {
  const className = [
    'vc-node-output-thumb',
    `is-${output.status}`,
    output.active ? 'is-active' : '',
  ].filter(Boolean).join(' ')
  return (
    <button
      type="button"
      className={className}
      onClick={(e) => {
        e.stopPropagation()
        if (!output.active) onPromote()
      }}
      title={output.assetId}
    >
      {output.thumbnailSrc ? <img src={output.thumbnailSrc} alt="" /> : null}
      {output.status === 'pending' ? <Loader2 /> : output.status === 'error' ? <AlertCircle /> : output.status === 'missing' ? <FileQuestion /> : null}
    </button>
  )
}

function GenNodeComponent({ data, selected }: NodeProps) {
  const node = data as NotebookNodeData
  const { step } = node
  const isCapture = Boolean(step.properties.is_capture)
  const Icon = step.type === 'video' ? Video : ImageIcon
  const model = typeof step.properties.model === 'string' && step.properties.model
    ? step.properties.model
    : isCapture ? (typeof step.properties.provider === 'string' ? step.properties.provider : 'unknown') : 'choose model'
  const mediaInputs = node.mediaInputs ?? []
  const outputs = node.outputs ?? []
  return (
    <div className={`vc-node vc-node-gen vc-node-${step.type} ${selected ? 'vc-node-selected' : ''} ${node.invalidReason ? 'vc-node-invalid' : ''} ${node.routeState ? `vc-node-route-${node.routeState}` : ''} ${isCapture ? 'vc-node-capture' : ''}`}>
      {!isCapture ? <Handle type="target" position={Position.Top} className="vc-node-handle" /> : null}
      <div className="vc-node-kicker"><span><Icon aria-hidden /> {step.type === 'video' ? 'Video Prompt' : 'Image Prompt'}</span><b>{step.type === 'video' ? 'VID' : 'IMG'}</b></div>
      {mediaInputs.length > 0 ? (
        <div className="vc-node-input-strip" aria-label="Connected media inputs">
          {mediaInputs.map((item) => (
            <MediaInputThumb key={item.sourceId} item={item} />
          ))}
        </div>
      ) : null}
      <div className="vc-node-hero">
        {node.thumbnailSrc ? <img src={node.thumbnailSrc} alt="" /> : <Icon />}
        <span className={`vc-node-status vc-node-status-${node.running ? 'running' : (isCapture ? step.properties.capture_status : node.runState)}`}>
          {node.running || (isCapture && step.properties.capture_status === 'pending') ? <Loader2 /> : node.error || node.runState === 'error' || (isCapture && step.properties.capture_status === 'failed') ? <AlertCircle /> : null}
        </span>
      </div>
      {outputs.length > 1 ? (
        <div className="vc-node-output-strip nodrag" aria-label="Run history">
          {outputs.map((output) => (
            <GenOutputThumb
              key={output.assetId}
              output={output}
              onPromote={() => node.onPromoteAsset?.(step.id, output.assetId)}
            />
          ))}
        </div>
      ) : null}
      <div className="vc-node-meta">
        <span>{model}</span>
        {node.cost && <b>{node.cost}</b>}
      </div>
      {!isCapture ? <Handle type="source" position={Position.Bottom} className="vc-node-handle" /> : null}
    </div>
  )
}

export const GenNode = memo(GenNodeComponent)
