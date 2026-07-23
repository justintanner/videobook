import type { Edge, Node } from '@xyflow/react'
import type {
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from 'videobook-engine'

export interface NotebookCellData extends Record<string, unknown> {
  kind: NotebookCellType
  title: string
  subtitle: string
  stage: number
  status: string
  preview?: string
  prompt?: string
  model?: string
  entityId?: string
  outputAssetId?: string
  inputs?: Record<string, unknown>
}

function positionsOverlap(
  left: NotebookCell['position'],
  right: NotebookCell['position'],
): boolean {
  return Math.abs(left.x - right.x) < 520
    && Math.abs(left.y - right.y) < 330
}

function normalizedPositions(cells: NotebookCell[]): NotebookCell['position'][] {
  const positions: NotebookCell['position'][] = []
  for (const cell of cells) {
    let position = cell.position
    let attempt = 0
    while (positions.some((existing) => positionsOverlap(existing, position))) {
      attempt += 1
      position = { x: cell.position.x + 610 * attempt, y: cell.position.y }
    }
    positions.push(position)
  }
  return positions
}

export function notebookNodes(document: NotebookDocument): Array<Node<NotebookCellData>> {
  const positions = normalizedPositions(document.cells)
  return document.cells.map((cell, index) => ({
    id: cell.id,
    type: 'cell',
    position: positions[index],
    data: {
      kind: cell.type,
      title: cell.title,
      subtitle: `${cell.type.toUpperCase()} · CELL`,
      stage: Math.floor(index / 3) + 1,
      status: 'ready',
      ...(cell.prompt === undefined ? {} : { prompt: cell.prompt }),
      ...(cell.model === undefined ? {} : { model: cell.model }),
      ...(cell.entityId === undefined ? {} : { entityId: cell.entityId }),
      ...(cell.outputAssetId === undefined
        ? {}
        : { outputAssetId: cell.outputAssetId }),
      ...(cell.inputs === undefined ? {} : { inputs: cell.inputs }),
    },
  }))
}

export function notebookEdges(document: NotebookDocument): Edge[] {
  return document.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    targetHandle: edge.targetInput,
  }))
}

function cellFromNode(node: Node<NotebookCellData>): NotebookCell {
  return {
    id: node.id,
    type: node.data.kind,
    title: node.data.title,
    position: node.position,
    ...(node.data.prompt === undefined ? {} : { prompt: node.data.prompt }),
    ...(node.data.model === undefined ? {} : { model: node.data.model }),
    ...(node.data.entityId === undefined
      ? {}
      : { entityId: node.data.entityId }),
    ...(node.data.outputAssetId === undefined
      ? {}
      : { outputAssetId: node.data.outputAssetId }),
    ...(node.data.inputs === undefined ? {} : { inputs: node.data.inputs }),
  }
}

export function notebookDocument(
  base: NotebookDocument,
  nodes: Array<Node<NotebookCellData>>,
  edges: Edge[],
  updatedAt: string,
): NotebookDocument {
  return {
    ...base,
    cells: nodes.map(cellFromNode),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      targetInput: edge.targetHandle ?? 'input',
    })),
    updatedAt,
  }
}
