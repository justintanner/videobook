import type { NotebookCell, NotebookDocument, NotebookGridSlot } from "videobook-engine";
import {
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
} from "videobook-engine";
import { notebookGridTag, notebookOccupiedSlots } from "videobook-engine/notebook-grid";

export function slotBelowArtifactOrFirstFree(notebook: NotebookDocument, sourceArtifactId: string, fullMessage: string): NotebookGridSlot {
  const occupied = new Set(notebookOccupiedSlots(notebook.cells).map(notebookGridTag));
  const source = notebook.cells.find((cell) => cell.outputArtifactId === sourceArtifactId);
  const below = source ? { row: source.slot.row + 1, column: source.slot.column } : null;
  if (below && below.row < NOTEBOOK_GRID_ROW_COUNT && !occupied.has(notebookGridTag(below))) return below;
  for (let row = 0; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      const slot = { row, column };
      if (!occupied.has(notebookGridTag(slot))) return slot;
    }
  }
  throw new Error(fullMessage);
}

export function slotBelow(slot: NotebookGridSlot): NotebookGridSlot {
  if (slot.row + 1 < NOTEBOOK_GRID_ROW_COUNT) {
    return { row: slot.row + 1, column: slot.column };
  }
  return {
    row: slot.row,
    column: Math.min(slot.column + 1, NOTEBOOK_GRID_COLUMN_COUNT - 1),
  };
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

export function nextGenerationOutputSlot(
  producerType: string,
  producerSlot: NotebookGridSlot,
  occupied: readonly NotebookGridSlot[],
): NotebookGridSlot {
  if (producerType === "generate_video") {
    return nextVerticalSlotFrom(slotBelow(producerSlot), occupied);
  }
  return nextHorizontalSlotFrom(slotRight(producerSlot), occupied);
}
