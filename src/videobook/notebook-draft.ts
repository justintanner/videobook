import { MarkerType, type Edge, type Node } from '@xyflow/react'
import type {
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from 'videobook-engine'
import {
  notebookGridHeadingPosition,
  notebookGridPosition,
} from './notebook-grid'

export interface NotebookCellData extends Record<string, unknown> {
  kind: NotebookCellType
  title: string
  subtitle: string
  slot: NotebookCell['slot']
  status: string
  preview?: string
  prompt?: string
  model?: string
  entityId?: string
  outputArtifactId?: string
  inputs?: Record<string, unknown>
  targetInputs?: string[]
}

export function notebookNodes(document: NotebookDocument): Array<Node<NotebookCellData>> {
  const targetInputs = new Map<string, string[]>()
  for (const edge of document.edges) {
    const inputs = targetInputs.get(edge.target) ?? []
    if (!inputs.includes(edge.targetInput)) inputs.push(edge.targetInput)
    targetInputs.set(edge.target, inputs)
  }
  return document.cells.map((cell) => {
    return {
      id: cell.id,
      type: 'cell',
      position: cell.type === 'label'
        ? notebookGridHeadingPosition(cell.slot.column)
        : notebookGridPosition(cell.slot),
      draggable: cell.type !== 'label',
      data: {
        kind: cell.type,
        title: cell.title,
        subtitle: `${cell.type.toUpperCase()} · CELL`,
        slot: cell.slot,
        status: 'ready',
        targetInputs: targetInputs.get(cell.id) ?? ['input'],
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
    type: 'smoothstep',
    className: 'workflow-edge',
    markerEnd: {
      type: MarkerType.ArrowClosed,
      width: 18,
      height: 18,
      color: '#72e7aa',
    },
  }))
}

function cellFromNode(node: Node<NotebookCellData>): NotebookCell {
  return {
    id: node.id,
    type: node.data.kind,
    title: node.data.title,
    slot: node.data.slot,
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
