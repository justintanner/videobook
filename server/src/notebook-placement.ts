import type { NotebookCell, NotebookDocument, NotebookGridSlot } from "videobook-engine";
import { NOTEBOOK_GRID_COLUMN_COUNT, NOTEBOOK_GRID_ROW_COUNT } from "videobook-engine";
import { firstEmptyNotebookGridSlot, NOTEBOOK_GRID_FULL_ERROR, notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import { placeDerivedCell } from "./notebook-rounds-placement.js";

export function placeAfterArtifact(
  notebook: NotebookDocument,
  sourceArtifactId: string,
  fullMessage: string,
): { cells: NotebookCell[]; slot: NotebookGridSlot } {
  const source = notebook.cells.find((cell) => cell.outputArtifactId === sourceArtifactId);
  try {
    return source
      ? placeDerivedCell(notebook, source.id)
      : { cells: [...notebook.cells], slot: firstEmptyNotebookGridSlot(notebookOccupiedSlots(notebook.cells)) };
  } catch (error) {
    if (error instanceof Error && error.message === NOTEBOOK_GRID_FULL_ERROR) throw new Error(fullMessage);
    throw error;
  }
}

export function slotRight(slot: NotebookGridSlot): NotebookGridSlot {
  if (slot.column + 1 < NOTEBOOK_GRID_COLUMN_COUNT) {
    return { row: slot.row, column: slot.column + 1 };
  }
  return {
    row: Math.min(slot.row + 1, NOTEBOOK_GRID_ROW_COUNT - 1),
    column: slot.column,
  };
}

export function lastCreatedCellSlot(
  cells: readonly Pick<NotebookCell, "id" | "slot">[],
): NotebookGridSlot | null {
  if (cells.length === 0) return null;
  let latest = cells[0]!;
  for (const cell of cells) {
    if (cell.id > latest.id) latest = cell;
  }
  return latest.slot;
}

export function isVerticalGenerationType(type: string): boolean {
  return type === "generate_video"
    || type === "split_video"
    || type === "video"
    || type === "concat";
}
