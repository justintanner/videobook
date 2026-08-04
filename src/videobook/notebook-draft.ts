import {
  MarkerType,
  type Connection,
  type Edge,
  type Node,
} from '@xyflow/react'
import type {
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from 'videobook-engine'
import { notebookGridPosition } from './notebook-grid'
import {
  defaultNotebookBusRiverRoute,
  notebookBusRiverRoutes,
  notebookSourcePortId,
  type NotebookBusRiverRoute,
} from './notebook-routing'

export const notebookFocusedEdgeColor = 'rgba(79, 183, 125, 0.98)'

export type NotebookFlowEdge = Edge<NotebookBusRiverRoute, 'busRiver'>

export interface NotebookCellData extends Record<string, unknown> {
  kind: NotebookCellType
  label?: string
  subtitle: string
  slot: NotebookCell['slot']
  status: string
  statusStartedAt?: string
  statusError?: string
  preview?: string
  prompt?: string
  provider?: string
  model?: string
  operation?: string
  tool?: string
  outputEntityId?: string
  outputArtifactId?: string
  inputs?: Record<string, unknown>
  targetInputs?: string[]
  targetConnectionCount?: number
  sourcePorts?: string[]
}

type NotebookReferenceKind = 'image' | 'video' | 'audio'

function notebookReferenceKind(
  type: NotebookCellType,
): NotebookReferenceKind | null {
  if (
    type === 'image'
    || type === 'extract_frame'
    || type === 'generate_image'
  ) return 'image'
  if (
    type === 'video'
    || type === 'split_video'
    || type === 'generate_video'
    || type === 'concat'
    || type === 'splice'
  ) return 'video'
  if (
    type === 'audio'
    || type === 'extract_audio'
    || type === 'generate_audio'
  ) return 'audio'
  return null
}

function nextNotebookReferenceInput(
  document: NotebookDocument,
  targetId: string,
  kind: NotebookReferenceKind,
): string {
  const occupied = new Set(document.edges
    .filter((edge) => edge.target === targetId)
    .map((edge) => edge.targetInput))
  if (!occupied.has(kind)) return kind
  for (let ordinal = 2; ; ordinal += 1) {
    const input = `${kind}_${ordinal}`
    if (!occupied.has(input)) return input
  }
}

export function notebookConnectionTargetInput(
  document: NotebookDocument,
  connection: Pick<
    Connection,
    'source' | 'target' | 'targetHandle'
  >,
): string {
  const requestedInput = connection.targetHandle ?? 'input'
  const source = document.cells.find((cell) => cell.id === connection.source)
  const target = document.cells.find((cell) => cell.id === connection.target)
  if (!source || target?.type !== 'generate_video') return requestedInput
  const kind = notebookReferenceKind(source.type)
  if (!kind) return requestedInput
  if (
    kind === 'image'
    && (requestedInput === 'first_frame' || requestedInput === 'last_frame')
  ) return requestedInput
  if (
    kind === 'audio'
    && (requestedInput === 'replace_audio' || requestedInput === 'scene_audio')
  ) return requestedInput
  return nextNotebookReferenceInput(document, target.id, kind)
}

function defaultTargetInputs(type: NotebookCellType): string[] {
  if (type === 'extract_audio') return ['video']
  if (type === 'extract_frame') return ['video']
  if (type === 'split_video') return ['video', 'analysis']
  if (type === 'analysis') return ['result']
  if (type === 'image') return ['media', 'segment']
  if (type === 'audio' || type === 'video') return ['media']
  return ['input']
}

export function notebookNodes(document: NotebookDocument): Array<Node<NotebookCellData>> {
  const routes = notebookBusRiverRoutes(document)
  const targetInputs = new Map<string, string[]>()
  const targetConnectionCounts = new Map<string, number>()
  const sourcePorts = new Map<string, string[]>()
  for (const edge of document.edges) {
    const inputs = targetInputs.get(edge.target) ?? []
    if (!inputs.includes(edge.targetInput)) inputs.push(edge.targetInput)
    targetInputs.set(edge.target, inputs)
    targetConnectionCounts.set(
      edge.target,
      (targetConnectionCounts.get(edge.target) ?? 0) + 1,
    )
    const route = routes.get(edge.id) ?? defaultNotebookBusRiverRoute
    const port = notebookSourcePortId(route.sourceSide, route.sourcePortIndex)
    const ports = sourcePorts.get(edge.source) ?? []
    if (!ports.includes(port)) ports.push(port)
    sourcePorts.set(edge.source, ports)
  }
  return document.cells.map((cell) => {
    return {
      id: cell.id,
      type: 'cell',
      position: notebookGridPosition(cell.slot),
      data: {
        kind: cell.type,
        ...(cell.label === undefined ? {} : { label: cell.label }),
        subtitle: `${cell.type.toUpperCase()} · CELL`,
        slot: cell.slot,
        status: 'ready',
        targetInputs: targetInputs.get(cell.id) ?? defaultTargetInputs(cell.type),
        targetConnectionCount: targetConnectionCounts.get(cell.id) ?? 0,
        sourcePorts: sourcePorts.get(cell.id) ?? [],
        ...(cell.prompt === undefined ? {} : { prompt: cell.prompt }),
        ...(cell.provider === undefined ? {} : { provider: cell.provider }),
        ...(cell.model === undefined ? {} : { model: cell.model }),
        ...(cell.operation === undefined ? {} : { operation: cell.operation }),
        ...(cell.tool === undefined ? {} : { tool: cell.tool }),
        ...(cell.outputEntityId === undefined
          ? {}
          : { outputEntityId: cell.outputEntityId }),
        ...(cell.outputArtifactId === undefined
          ? {}
          : { outputArtifactId: cell.outputArtifactId }),
        ...(cell.inputs === undefined ? {} : { inputs: cell.inputs }),
      },
    }
  })
}

export function notebookNodesWithCellStatus<Data extends NotebookCellData>(
  nodes: Array<Node<Data>>,
  cellId: string,
  status: string,
): Array<Node<Data>> {
  let changed = false
  const next = nodes.map((node) => {
    if (node.id !== cellId || node.data.status === status) return node
    changed = true
    return {
      ...node,
      data: {
        ...node.data,
        status,
      } as Data,
    }
  })
  return changed ? next : nodes
}

export function notebookEdges(
  document: NotebookDocument,
): NotebookFlowEdge[] {
  const routes = notebookBusRiverRoutes(document)
  return document.edges.map((edge) => {
    const route = routes.get(edge.id) ?? defaultNotebookBusRiverRoute
    return {
      id: edge.id,
      source: edge.source,
      sourceHandle: notebookSourcePortId(
        route.sourceSide,
        route.sourcePortIndex,
      ),
      target: edge.target,
      targetHandle: edge.targetInput,
      type: 'busRiver',
      className: 'workflow-edge',
      data: route,
      ...(route.targetPrimary
        ? {
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 18,
              height: 18,
              color: 'rgba(114, 231, 170, 0.38)',
            },
          }
        : {}),
    }
  })
}

export function notebookEdgesWithCellFocus(
  edges: NotebookFlowEdge[],
  selectedCellId: string | null,
): NotebookFlowEdge[] {
  if (!selectedCellId) return edges
  return edges.map((edge) => {
    if (edge.source !== selectedCellId && edge.target !== selectedCellId) {
      return edge
    }
    const classNames = new Set(
      (edge.className ?? '').split(/\s+/).filter(Boolean),
    )
    classNames.add('workflow-edge-cell-focus')
    const markerEnd = edge.markerEnd && typeof edge.markerEnd === 'object'
      ? { ...edge.markerEnd, color: notebookFocusedEdgeColor }
      : edge.markerEnd
    return {
      ...edge,
      className: [...classNames].join(' '),
      markerEnd,
    }
  })
}

function cellFromNode(node: Node<NotebookCellData>): NotebookCell {
  return {
    id: node.id,
    type: node.data.kind,
    ...(node.data.label === undefined ? {} : { label: node.data.label }),
    slot: node.data.slot,
    ...(node.data.prompt === undefined ? {} : { prompt: node.data.prompt }),
    ...(node.data.provider === undefined ? {} : { provider: node.data.provider }),
    ...(node.data.model === undefined ? {} : { model: node.data.model }),
    ...(node.data.operation === undefined ? {} : { operation: node.data.operation }),
    ...(node.data.tool === undefined ? {} : { tool: node.data.tool }),
    ...(node.data.outputEntityId === undefined
      ? {}
      : { outputEntityId: node.data.outputEntityId }),
    ...(node.data.outputArtifactId === undefined
      ? {}
      : { outputArtifactId: node.data.outputArtifactId }),
    ...(node.data.inputs === undefined ? {} : { inputs: node.data.inputs }),
  }
}

export function notebookDocument(
  base: NotebookDocument,
  nodes: Array<Node<NotebookCellData>>,
  edges: Edge[],
): NotebookDocument {
  const baseCells = new Map(base.cells.map((cell) => [cell.id, cell]))
  return {
    ...base,
    cells: nodes.map((node) => ({
      ...baseCells.get(node.id),
      ...cellFromNode(node),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      targetInput: edge.targetHandle ?? 'input',
    })),
  }
}
