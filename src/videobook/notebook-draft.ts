import type { Edge, Node } from '@xyflow/react'
import type {
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from 'videobook-engine'
import {
  notebookGridSlot,
  normalizeNotebookGridNodes,
  normalizeNotebookGridPositions,
} from './notebook-grid'

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
  outputArtifactId?: string
  inputs?: Record<string, unknown>
}

export function notebookNodes(document: NotebookDocument): Array<Node<NotebookCellData>> {
  const positions = normalizeNotebookGridPositions(document.cells.map((cell) => cell.position))
  return document.cells.map((cell, index) => {
    const position = positions[index]!
    const slot = notebookGridSlot(position)
    return {
      id: cell.id,
      type: 'cell',
      position,
      data: {
        kind: cell.type,
        title: cell.title,
        subtitle: `${cell.type.toUpperCase()} · CELL`,
        stage: slot.stage + 1,
        status: 'ready',
        ...(cell.prompt === undefined ? {} : { prompt: cell.prompt }),
        ...(cell.model === undefined ? {} : { model: cell.model }),
        ...(cell.entityId === undefined ? {} : { entityId: cell.entityId }),
        ...(cell.outputArtifactId === undefined
          ? {}
          : { outputArtifactId: cell.outputArtifactId }),
        ...(cell.inputs === undefined ? {} : { inputs: cell.inputs }),
      },
    }
  })
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
  const normalizedNodes = normalizeNotebookGridNodes(nodes)
  return {
    ...base,
    cells: normalizedNodes.map(cellFromNode),
    edges: edges.map((edge) => ({
      id: edge.id,
      source: edge.source,
      target: edge.target,
      targetInput: edge.targetHandle ?? 'input',
    })),
  }
}
