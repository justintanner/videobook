import type { NotebookCell, NotebookGridSlot } from "videobook-engine";
import {
  firstEmptyNotebookGridSlots,
  nextHorizontalSlotFrom,
  nextVerticalSlotFrom,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
} from "videobook-engine";

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

export function nextAnchoredEmptySlot(
  occupied: readonly NotebookGridSlot[],
  lastWorkSlot: NotebookGridSlot | null,
  direction: "horizontal" | "vertical",
): NotebookGridSlot {
  if (occupied.length === 0) {
    return firstEmptyNotebookGridSlots([], 1)[0]!;
  }
  const start = lastWorkSlot ?? { row: 0, column: 0 };
  return direction === "vertical"
    ? nextVerticalSlotFrom(start, occupied)
    : nextHorizontalSlotFrom(start, occupied);
}
