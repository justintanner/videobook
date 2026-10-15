import type {
  NotebookCell,
  NotebookCellType,
  NotebookDocument,
} from "videobook-engine";

export const PUBLISHED_POST_SOURCE_OPERATION = "post_to_x";
export const PUBLISHED_POST_TARGET_INPUT = "post";

export function isPublishedPostCell(
  cell: Pick<NotebookCell, "inputs"> & { type?: string },
): boolean {
  return cell.type === "post" || cell.inputs?.sourceOperation === PUBLISHED_POST_SOURCE_OPERATION;
}

export function sourceCellForPostedArtifact(
  notebook: NotebookDocument,
  artifactId: string,
  cellType?: NotebookCellType,
): NotebookCell | null {
  const holders = notebook.cells.filter((cell) =>
    cell.outputArtifactId === artifactId && !isPublishedPostCell(cell));
  if (cellType) {
    const typed = holders.find((cell) => cell.type === cellType);
    if (typed) return typed;
  }
  return holders.find((cell) => cell.type === "video" || cell.type === "image")
    ?? holders[0]
    ?? null;
}

export function resolvePublishedPostSourceCell(
  document: NotebookDocument,
  cell: NotebookCell,
): NotebookCell {
  if (!isPublishedPostCell(cell)) return cell;
  const sourceId = cell.type === "post" ? (cell.inputs?.post as { source?: { cellId?: string } } | undefined)?.source?.cellId : typeof cell.inputs?.sourceCellId === "string"
    ? cell.inputs.sourceCellId
    : null;
  if (!sourceId) return cell;
  return document.cells.find((candidate) => candidate.id === sourceId) ?? cell;
}
