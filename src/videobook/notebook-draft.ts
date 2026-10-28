import type { Connection, Edge, Node } from '@xyflow/react'
import type {
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { mediaGenerationProducer } from './media-cell-generation-state'
import { notebookCellFamily } from './notebook-cell-types'
import {
  isPublishedPostCell,
  publishedPostSubtitle,
} from './notebook-published-post'
import { notebookGridPosition } from './notebook-grid'
import {
  defaultNotebookBusRiverRoute,
  notebookBusRiverRoutes,
  notebookSourcePortId,
  type NotebookBusRiverRoute,
} from './notebook-routing'

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
  targetInputConnectionCounts?: Record<string, number>
  sourcePorts?: string[]
  frameProvenance?: NotebookFrameProvenance
  producerProvider?: string
  producerModel?: string
}

type NotebookFrameProvenance = {
  sourceAddress: string | null
  atSeconds: number | null
}

type NotebookReferenceKind = 'image' | 'video' | 'audio'

function notebookReferenceKind(
  type: NotebookCellType,
): NotebookReferenceKind | null {
  if (
    type === 'image'
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

function notebookCellAcceptsReferences(type: NotebookCellType): boolean {
  return type === 'generate_image'
    || type === 'generate_video'
    || type === 'generate_audio'
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
  if (!source || !target || !notebookCellAcceptsReferences(target.type)) {
    return requestedInput
  }
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
  if (type === 'split_video') return ['video', 'analysis']
  if (type === 'analysis') return ['result']
  if (type === 'image') return ['media', 'segment']
  if (type === 'audio' || type === 'video') return ['media']
  return ['input']
}

function cellFrameProvenance(
  cellsById: ReadonlyMap<string, NotebookCell>,
  cell: NotebookCell,
): NotebookFrameProvenance | null {
  if (cell.inputs?.mediaRole !== 'extract-frame-output') return null
  const sourceCellId = typeof cell.inputs.sourceCellId === 'string'
    ? cell.inputs.sourceCellId
    : null
  const sourceCell = sourceCellId ? cellsById.get(sourceCellId) : undefined
  const atSecondsValue = Number(
    cell.inputs.atSeconds ?? cell.inputs.timestampSeconds,
  )
  return {
    sourceAddress: sourceCell ? notebookGridTag(sourceCell.slot) : null,
    atSeconds: Number.isFinite(atSecondsValue) ? atSecondsValue : null,
  }
}

export function notebookNodes(document: NotebookDocument): Array<Node<NotebookCellData>> {
  const cellsById = new Map(document.cells.map((cell) => [cell.id, cell]))
  const routes = notebookBusRiverRoutes(document)
  const targetInputs = new Map<string, string[]>()
  const targetConnectionCounts = new Map<string, number>()
  const targetInputConnectionCounts = new Map<string, Record<string, number>>()
  const sourcePorts = new Map<string, string[]>()
  for (const edge of document.edges) {
    const inputs = targetInputs.get(edge.target) ?? []
    if (!inputs.includes(edge.targetInput)) inputs.push(edge.targetInput)
    targetInputs.set(edge.target, inputs)
    targetConnectionCounts.set(
      edge.target,
      (targetConnectionCounts.get(edge.target) ?? 0) + 1,
    )
    const inputCounts = targetInputConnectionCounts.get(edge.target) ?? {}
    inputCounts[edge.targetInput] = (inputCounts[edge.targetInput] ?? 0) + 1
    targetInputConnectionCounts.set(edge.target, inputCounts)
    const route = routes.get(edge.id) ?? defaultNotebookBusRiverRoute
    const port = notebookSourcePortId(route.sourceSide, route.sourcePortIndex)
    const ports = sourcePorts.get(edge.source) ?? []
    if (!ports.includes(port)) ports.push(port)
    sourcePorts.set(edge.source, ports)
  }
  return document.cells.map((cell) => {
    const frameProvenance = cellFrameProvenance(cellsById, cell)
    const producer = mediaGenerationProducer(cell, document.cells, document.edges)
    return {
      id: cell.id,
      type: cell.type === 'timeline' || cell.type === 'goal' ? cell.type : 'cell',
      ...(cell.type === 'timeline' ? { dragHandle: '.notebook-timeline-header', connectable: false } : {}),
      ...(['goal', 'post'].includes(cell.type) ? { connectable: false } : {}),
      position: notebookGridPosition(cell.slot),
      data: {
        kind: cell.type,
        ...(cell.label === undefined ? {} : { label: cell.label }),
        subtitle: isPublishedPostCell(cell)
          ? publishedPostSubtitle()
          : `${cell.type.toUpperCase()} · CELL`,
        slot: cell.slot,
        status: 'ready',
        targetInputs: targetInputs.get(cell.id) ?? defaultTargetInputs(cell.type),
        targetConnectionCount: targetConnectionCounts.get(cell.id) ?? 0,
        targetInputConnectionCounts:
          targetInputConnectionCounts.get(cell.id) ?? {},
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
        ...(frameProvenance === null ? {} : { frameProvenance }),
        ...(producer?.provider === undefined
          ? {}
          : { producerProvider: producer.provider }),
        ...(producer?.model === undefined ? {} : { producerModel: producer.model }),
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
  const familiesById = new Map(document.cells.map((cell) => [
    cell.id,
    notebookCellFamily(cell.type),
  ]))
  return document.edges.map((edge) => {
    const route = routes.get(edge.id) ?? defaultNotebookBusRiverRoute
    const family = familiesById.get(edge.source) ?? 'data'
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
      className: `workflow-edge edge-family-${family}`,
      data: route,
    }
  })
}

interface NotebookLineageEdge {
  source: string
  target: string
}

function notebookReachableCellIds(
  edges: readonly NotebookLineageEdge[],
  cellId: string,
  direction: 'upstream' | 'downstream',
): Set<string> {
  const reached = new Set<string>()
  const pending = [cellId]
  while (pending.length > 0) {
    const current = pending.pop()!
    for (const edge of edges) {
      const [from, to] = direction === 'upstream'
        ? [edge.target, edge.source]
        : [edge.source, edge.target]
      if (from !== current || reached.has(to) || to === cellId) continue
      reached.add(to)
      pending.push(to)
    }
  }
  return reached
}

interface NotebookCellLineage {
  upstream: ReadonlySet<string>
  downstream: ReadonlySet<string>
}

function notebookCellLineage(
  edges: readonly NotebookLineageEdge[],
  cellId: string,
): NotebookCellLineage {
  return {
    upstream: notebookReachableCellIds(edges, cellId, 'upstream'),
    downstream: notebookReachableCellIds(edges, cellId, 'downstream'),
  }
}

export function notebookLineageCellIds(
  edges: readonly NotebookLineageEdge[],
  cellId: string | null,
): ReadonlySet<string> | null {
  if (!cellId) return null
  const lineage = notebookCellLineage(edges, cellId)
  if (lineage.upstream.size === 0 && lineage.downstream.size === 0) return null
  return new Set([cellId, ...lineage.upstream, ...lineage.downstream])
}

function edgeInLineage(
  edge: NotebookLineageEdge,
  cellId: string,
  lineage: NotebookCellLineage,
): boolean {
  const feedsSelection = lineage.upstream.has(edge.source)
    && (edge.target === cellId || lineage.upstream.has(edge.target))
  const leavesSelection = lineage.downstream.has(edge.target)
    && (edge.source === cellId || lineage.downstream.has(edge.source))
  return feedsSelection || leavesSelection
}

export function notebookEdgesWithCellFocus(
  edges: NotebookFlowEdge[],
  selectedCellId: string | null,
): NotebookFlowEdge[] {
  if (!selectedCellId) return edges
  const lineage = notebookCellLineage(edges, selectedCellId)
  return edges.map((edge) => {
    const classNames = new Set(
      (edge.className ?? '').split(/\s+/).filter(Boolean),
    )
    classNames.add(
      edgeInLineage(edge, selectedCellId, lineage)
        ? 'workflow-edge-cell-focus'
        : 'workflow-edge-cell-dim',
    )
    return {
      ...edge,
      className: [...classNames].join(' '),
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
