import { applyEdgeChanges, applyNodeChanges, type Edge, type EdgeChange, type NodeChange } from '@xyflow/react'
import { useCallback, useEffect, useState, useRef } from 'react'
import {
  connectedMediaInputs,
  latestAssetId,
  notebookTrackLayout,
  stepInputs,
  stepInvalidReason,
  stepPosition,
  stepRunStatus,
  constrainTrackDragPosition,
  stepRunOutputs,
  type GenRunOutput,
} from './model'
import { NODE_DIMENSIONS, type NotebookFlowNode, type NotebookNodeData } from './nodes/nodeTypes'
import type { NotebookPlanDefinition } from './types'
import type { MediaItem } from '@/components/sidebar/types'
import { computeTrunkGroups, trunkEdgeDataEqual, type TrunkEdgeData } from './trunk-edges.js'

interface NotebookFlowOptions {
  definition: NotebookPlanDefinition | null
  mediaItems: MediaItem[]
  stepCosts: ReadonlyMap<string, string>
  runningStepIds: ReadonlySet<string>
  errors: ReadonlyMap<string, string>
  selectedStepId: string | null
  onPromoteAsset?: (stepId: string, assetId: string) => void
}

interface ActiveRoute {
  nodeStates: ReadonlyMap<string, NotebookNodeData['routeState']>
  edgeIds: ReadonlySet<string>
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

function outputsEqual(left: GenRunOutput[], right: GenRunOutput[]): boolean {
  if (left.length !== right.length) return false
  return left.every((item, index) => {
    const other = right[index]
    return item.assetId === other.assetId
      && item.thumbnailSrc === other.thumbnailSrc
      && item.status === other.status
      && item.active === other.active
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
    && left.routeState === right.routeState
    && mediaInputsEqual(left.mediaInputs, right.mediaInputs)
    && outputsEqual(left.outputs, right.outputs)
}

function activeRoute(definition: NotebookPlanDefinition, selectedStepId: string | null): ActiveRoute {
  const nodeStates = new Map<string, NotebookNodeData['routeState']>()
  const edgeIds = new Set<string>()
  if (!selectedStepId) return { nodeStates, edgeIds }
  const byId = new Map(definition.sequence.map((step) => [step.id, step]))
  const children = new Map<string, string[]>()
  for (const step of definition.sequence) {
    for (const parentId of stepInputs(step)) {
      const current = children.get(parentId) ?? []
      current.push(step.id)
      children.set(parentId, current)
    }
  }
  const upstreamVisited = new Set<string>()
  const downstreamVisited = new Set<string>()
  const visitUpstream = (id: string) => {
    if (upstreamVisited.has(id)) return
    upstreamVisited.add(id)
    const step = byId.get(id)
    if (!step) return
    for (const parentId of stepInputs(step)) {
      edgeIds.add(`${parentId}->${id}`)
      if (!nodeStates.has(parentId)) nodeStates.set(parentId, 'upstream')
      visitUpstream(parentId)
    }
  }
  const visitDownstream = (id: string) => {
    if (downstreamVisited.has(id)) return
    downstreamVisited.add(id)
    for (const childId of children.get(id) ?? []) {
      edgeIds.add(`${id}->${childId}`)
      if (!nodeStates.has(childId)) nodeStates.set(childId, 'downstream')
      visitDownstream(childId)
    }
  }
  nodeStates.set(selectedStepId, 'selected')
  visitUpstream(selectedStepId)
  visitDownstream(selectedStepId)
  return { nodeStates, edgeIds }
}

function nodeData(
  definition: NotebookPlanDefinition,
  step: NotebookPlanDefinition['sequence'][number],
  mediaItems: MediaItem[],
  stepCosts: ReadonlyMap<string, string>,
  runningStepIds: ReadonlySet<string>,
  errors: ReadonlyMap<string, string>,
  route: ActiveRoute,
  promoteAssetRef: React.MutableRefObject<((stepId: string, assetId: string) => void) | undefined>,
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
    outputs: stepRunOutputs(step, mediaItems),
    routeState: route.nodeStates.get(step.id) ?? null,
    onPromoteAsset: (stepId: string, assetId: string) => promoteAssetRef.current?.(stepId, assetId),
  }
}

function desiredNodes(
  definition: NotebookPlanDefinition,
  mediaItems: MediaItem[],
  stepCosts: ReadonlyMap<string, string>,
  runningStepIds: ReadonlySet<string>,
  errors: ReadonlyMap<string, string>,
  route: ActiveRoute,
  promoteAssetRef: React.MutableRefObject<((stepId: string, assetId: string) => void) | undefined>,
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
      data: nodeData(definition, step, mediaItems, stepCosts, runningStepIds, errors, route, promoteAssetRef),
    }
  })
}

function desiredEdges(
  definition: NotebookPlanDefinition,
  runningStepIds: ReadonlySet<string>,
  selectedStepId: string | null,
  route: ActiveRoute,
): Edge[] {
  const steps = new Map(definition.sequence.map((step) => [step.id, step]))
  const trunkGroups = computeTrunkGroups(definition)
  
  return definition.sequence.flatMap((target) => {
    if (target.type !== 'image' && target.type !== 'video') return []
    const inputRoutes = typeof target.properties.input_routes === 'object'
      && target.properties.input_routes !== null
      && !Array.isArray(target.properties.input_routes)
      ? target.properties.input_routes as Record<string, unknown>
      : {}
    const inputs = Array.isArray(target.properties.inputs)
      ? target.properties.inputs.filter((input): input is string => typeof input === 'string')
      : []
    return inputs.filter((source) => steps.has(source)).map((source) => {
      const id = `${source}->${target.id}`
      const classes = [steps.get(source)?.type === 'prompt' ? 'vc-notebook-edge-prompt' : 'vc-notebook-edge-ref']
      if (selectedStepId) classes.push(route.edgeIds.has(id) ? 'vc-notebook-edge-active' : 'vc-notebook-edge-muted')
      if (runningStepIds.has(source) || runningStepIds.has(target.id)) classes.push('vc-notebook-edge-running')
      
      const groupAssignment = trunkGroups.get(id)
      const data: TrunkEdgeData = {
        kind: steps.get(source)?.type === 'prompt' ? 'prompt' : 'ref',
        pinned: inputRoutes[source] === 'first_frame_slug',
        groupId: groupAssignment?.groupId ?? '',
        groupKind: groupAssignment?.groupKind ?? 'fan-in',
        groupSize: groupAssignment?.groupSize ?? 1,
        isPrimary: groupAssignment?.isPrimary ?? true,
        siblingIds: groupAssignment?.siblingIds ?? [],
        staggerIndex: groupAssignment?.staggerIndex ?? 0,
        groupActive: route.edgeIds.has(id) || !!groupAssignment?.siblingIds.some(sid => 
          groupAssignment.groupKind === 'fan-in' ? route.edgeIds.has(`${sid}->${target.id}`) : route.edgeIds.has(`${source}->${sid}`)
        ),
        groupRunning: runningStepIds.has(source) || runningStepIds.has(target.id) || !!groupAssignment?.siblingIds.some(sid => runningStepIds.has(sid)),
      }
      
      return {
        id,
        source,
        target: target.id,
        type: 'trunk',
        animated: false,
        className: classes.join(' '),
        zIndex: data.groupActive || data.groupRunning ? 2 : 0,
        data,
      }
    })
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
    if (
      old.className === next.className
      && trunkEdgeDataEqual(old.data as unknown as TrunkEdgeData, next.data as unknown as TrunkEdgeData)
      && old.type === next.type
    ) return old
    return { ...old, ...next }
  })
}

export function useNotebookFlow({
  definition,
  mediaItems,
  stepCosts,
  runningStepIds,
  errors,
  selectedStepId,
  onPromoteAsset,
}: NotebookFlowOptions) {
  const [nodes, setNodes] = useState<NotebookFlowNode[]>([])
  const [edges, setEdges] = useState<Edge[]>([])

  const promoteAssetRef = useRef(onPromoteAsset)
  useEffect(() => {
    promoteAssetRef.current = onPromoteAsset
  }, [onPromoteAsset])

  useEffect(() => {
    let cancelled = false
    const reconcile = () => {
      if (cancelled) return
      if (!definition) {
        setNodes([])
        setEdges([])
        return
      }
      const route = activeRoute(definition, selectedStepId)
      const nextNodes = desiredNodes(definition, mediaItems, stepCosts, runningStepIds, errors, route, promoteAssetRef)
      const nextEdges = desiredEdges(definition, runningStepIds, selectedStepId, route)
      setNodes((previous) => reconcileNodes(previous, nextNodes))
      setEdges((previous) => reconcileEdges(previous, nextEdges))
    }
    queueMicrotask(reconcile)
    return () => {
      cancelled = true
    }
  }, [definition, mediaItems, stepCosts, runningStepIds, errors, selectedStepId])

  const onNodesChange = useCallback((changes: NodeChange<NotebookFlowNode>[]) => {
    if (!definition) {
      setNodes((current) => applyNodeChanges(changes, current))
      return
    }
    const layout = notebookTrackLayout(definition)
    const constrained = changes.map((change) => {
      if (change.type !== 'position' || !change.position) return change
      return {
        ...change,
        position: constrainTrackDragPosition(definition, layout, change.id, change.position),
      }
    })
    setNodes((current) => applyNodeChanges(constrained, current))
  }, [definition])

  const onEdgesChange = useCallback((changes: EdgeChange[]) => {
    setEdges((current) => applyEdgeChanges(changes, current))
  }, [])

  return { nodes, edges, onNodesChange, onEdgesChange }
}
