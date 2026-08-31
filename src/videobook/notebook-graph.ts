import type { NotebookEdge } from 'videobook-engine'

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
