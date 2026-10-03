import type { NotebookCell, NotebookEdge } from "videobook-engine";

export function notebookConnectionWouldCreateCycle(
  edges: readonly NotebookEdge[],
  sourceCellId: string,
  targetCellId: string,
): boolean {
  if (sourceCellId === targetCellId) return true;
  const children = new Map<string, string[]>();
  for (const edge of edges) {
    const targets = children.get(edge.source) ?? [];
    targets.push(edge.target);
    children.set(edge.source, targets);
  }
  const visited = new Set<string>();
  const stack = [targetCellId];
  while (stack.length > 0) {
    const cellId = stack.pop();
    if (!cellId || visited.has(cellId)) continue;
    if (cellId === sourceCellId) return true;
    visited.add(cellId);
    stack.push(...(children.get(cellId) ?? []));
  }
  return false;
}

export function notebookConnectionEdges(
  cells: readonly NotebookCell[],
  edges: readonly NotebookEdge[],
  sourceCellId: string,
  targetCellId: string,
): readonly NotebookEdge[] | null {
  if (!notebookConnectionWouldCreateCycle(edges, sourceCellId, targetCellId)) {
    return edges;
  }
  const source = cells.find((cell) => cell.id === sourceCellId);
  if (
    sourceCellId === targetCellId
    || source?.type !== "image"
    || !source.outputArtifactId
  ) return null;
  const retained = edges.filter((edge) =>
    edge.target !== sourceCellId
    || !notebookConnectionWouldCreateCycle(edges, edge.source, targetCellId));
  return notebookConnectionWouldCreateCycle(retained, sourceCellId, targetCellId)
    ? null
    : retained;
}
