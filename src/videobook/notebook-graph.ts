import type { NotebookEdge, NotebookGridSlot } from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'

export function notebookConnectionWouldCreateCycle(
  edges: readonly NotebookEdge[],
  sourceCellId: string,
  targetCellId: string,
): boolean {
  if (sourceCellId === targetCellId) return true
  const children = new Map<string, string[]>()
  for (const edge of edges) {
    const targets = children.get(edge.source) ?? []
    targets.push(edge.target)
    children.set(edge.source, targets)
  }
  const visited = new Set<string>()
  const stack = [targetCellId]
  while (stack.length > 0) {
    const cellId = stack.pop()
    if (!cellId || visited.has(cellId)) continue
    if (cellId === sourceCellId) return true
    visited.add(cellId)
    stack.push(...(children.get(cellId) ?? []))
  }
  return false
}

export function isValidNotebookFlowConnection(
  edges: readonly NotebookEdge[],
  connection: { source?: string | null; target?: string | null },
): boolean {
  const sourceId = connection.source
  const targetId = connection.target
  if (!sourceId || !targetId) return false
  return !notebookConnectionWouldCreateCycle(edges, sourceId, targetId)
}

export function notebookCyclicInputMentionValues(
  cells: readonly { id: string; slot: NotebookGridSlot }[],
  edges: readonly NotebookEdge[],
  targetCellId: string,
): Set<string> {
  return new Set(
    cells
      .filter((cell) =>
        notebookConnectionWouldCreateCycle(edges, cell.id, targetCellId))
      .map((cell) => notebookGridTag(cell.slot)),
  )
}
