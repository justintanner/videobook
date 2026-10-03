import type { NotebookCell, NotebookEdge } from 'videobook-engine'
import { notebookGridTag } from 'videobook-engine/notebook-grid'
import { notebookConnectionEdges } from '../../server/src/notebook-graph'

export { notebookConnectionEdges, notebookConnectionWouldCreateCycle } from '../../server/src/notebook-graph'

export function isValidNotebookFlowConnection(
  edges: readonly NotebookEdge[],
  connection: { source?: string | null; target?: string | null },
  cells: readonly NotebookCell[] = [],
): boolean {
  const sourceId = connection.source
  const targetId = connection.target
  if (!sourceId || !targetId) return false
  return notebookConnectionEdges(cells, edges, sourceId, targetId) !== null
}

export function notebookCyclicInputMentionValues(
  cells: readonly NotebookCell[],
  edges: readonly NotebookEdge[],
  targetCellId: string,
): Set<string> {
  return new Set(
    cells
      .filter((cell) =>
        notebookConnectionEdges(cells, edges, cell.id, targetCellId) === null)
      .map((cell) => notebookGridTag(cell.slot)),
  )
}
