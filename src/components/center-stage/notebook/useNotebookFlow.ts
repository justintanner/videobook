import { applyEdgeChanges, applyNodeChanges, type Edge, type EdgeChange, type NodeChange } from '@xyflow/react'
import { useCallback, useEffect, useState } from 'react'
import { connectedMediaInputs, latestAssetId, stepInvalidReason, stepPosition, stepRunStatus } from './model'
import { NODE_DIMENSIONS, type NotebookFlowNode, type NotebookNodeData } from './nodes/nodeTypes'
import type { NotebookPlanDefinition } from './types'
import type { MediaItem } from '@/components/sidebar/types'

interface NotebookFlowOptions {
  definition: NotebookPlanDefinition | null
  mediaItems: MediaItem[]
  stepCosts: ReadonlyMap<string, string>
  runningStepIds: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
}

function mediaInputsEqual(
  left: NotebookNodeData['mediaInputs'],
  right: NotebookNodeData['mediaInputs'],
): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    return item.sourceId === other.sourceId
      && item.kind === other.kind
      && item.thumbnailSrc === other.thumbnailSrc
      && item.label === other.label
  })
}

function dataEqual(left: NotebookNodeData, right: NotebookNodeData): boolean {
  return left.step === right.step
    && left.thumbnailSrc === right.thumbnailSrc
    && left.cost === right.cost
    && left.runState === right.runState
    && left.running === right.running
    && left.error === right.error
    && left.invalidReason === right.invalidReason
    && left.missing === right.missing
    && mediaInputsEqual(left.mediaInputs, right.mediaInputs)
}

function nodeData(
  definition: NotebookPlanDefinition,
  step: NotebookPlanDefinition['sequence'][number],
  mediaItems: MediaItem[],
  stepCosts: ReadonlyMap<string, string>,
  runningStepIds: ReadonlySet<string>,
  errors: ReadonlyMap<string, string>,
): NotebookNodeData {
  const assetId = step.type === 'asset'
    ? typeof step.properties.slug === 'string' ? step.properties.slug.replace(/^@/, '') : null
    : latestAssetId(step)
  const asset = assetId ? mediaItems.find((item) => item.id === assetId) : null
  const status = stepRunStatus(step, mediaItems)
  return {
    step,
    thumbnailSrc: asset?.thumbnailSrc ?? null,
    cost: stepCosts.get(step.id) ?? null,
    runState: status.state,
    running: runningStepIds.has(step.id),
    error: errors.get(step.id) ?? null,
    invalidReason: stepInvalidReason(definition, step),
    missing: step.type === 'asset' && !asset,
    mediaInputs: connectedMediaInputs(definition, step, mediaItems),
  }
}

function desiredNodes(
  definition: NotebookPlanDefinition,
  mediaItems: MediaItem[],
  stepCosts: ReadonlyMap<string, string>,
  runningStepIds: ReadonlySet<string>,
  errors: ReadonlyMap<string, string>,
): NotebookFlowNode[] {
  return definition.sequence.map((step) => {
    const position = stepPosition(step) ?? { x: 0, y: 0 }
    const size = NODE_DIMENSIONS[step.type]
    return {
      id: step.id,
      type: step.type,
      position,
      width: size.width,
      height: size.height,
      data: nodeData(definition, step, mediaItems, stepCosts, runningStepIds, errors),
    }
  })
}

function desiredEdges(definition: NotebookPlanDefinition): Edge[] {
  const steps = new Map(definition.sequence.map((step) => [step.id, step]))
  return definition.sequence.flatMap((target) => {
    if (target.type !== 'image' && target.type !== 'video') return []
    const pin = typeof target.properties.first_frame_source === 'string'
      ? target.properties.first_frame_source
      : null
    const inputs = Array.isArray(target.properties.inputs)
      ? target.properties.inputs.filter((input): input is string => typeof input === 'string')
      : []
    return inputs.filter((source) => steps.has(source)).map((source) => ({
      id: `${source}->${target.id}`,
      source,
      target: target.id,
      className: steps.get(source)?.type === 'prompt' ? 'vc-notebook-edge-prompt' : 'vc-notebook-edge-ref',
      data: { kind: steps.get(source)?.type === 'prompt' ? 'prompt' : 'ref', pinned: pin === source },
    }))
  })
}

function reconcileNodes(previous: NotebookFlowNode[], desired: NotebookFlowNode[]): NotebookFlowNode[] {
  const existing = new Map(previous.map((node) => [node.id, node]))
  return desired.map((next) => {
    const old = existing.get(next.id)
    if (!old) return next
    const position = old.dragging ? old.position : next.position
    if (
      old.type === next.type
      && old.position.x === position.x
      && old.position.y === position.y
      && old.width === next.width
      && old.height === next.height
      && dataEqual(old.data, next.data)
    ) return old
    return { ...old, ...next, position }
  })
}

function reconcileEdges(previous: Edge[], desired: Edge[]): Edge[] {
  const existing = new Map(previous.map((edge) => [edge.id, edge]))
  return desired.map((next) => {
    const old = existing.get(next.id)
    if (!old) return next
    if (old.className === next.className && old.data?.pinned === next.data?.pinned) return old
    return { ...old, ...next }
  })
}

export function useNotebookFlow({
  definition,
  mediaItems,
  stepCosts,
  runningStepIds,
  errors,
}: NotebookFlowOptions) {
  const [nodes, setNodes] = useState<NotebookFlowNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])

  useEffect(() => {
    let cancelled = false
    const reconcile = () => {
      if (cancelled) return
      if (!definition) {
        setNodes([])
        setEdges([])
        return
      }
      const nextNodes = desiredNodes(definition, mediaItems, stepCosts, runningStepIds, errors)
      const nextEdges = desiredEdges(definition)
      setNodes((previous) => reconcileNodes(previous, nextNodes))
      setEdges((previous) => reconcileEdges(previous, nextEdges))
    }
    queueMicrotask(reconcile)
    return () => {
      cancelled = true
    }
  }, [definition, mediaItems, stepCosts, runningStepIds, errors])

  const onNodesChange = useCallback((changes: NodeChange<NotebookFlowNode>[]) => {
    setNodes((current) => applyNodeChanges(changes, current))
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current))
  }, [])

  return { nodes, edges, onNodesChange, onEdgesChange }
}
