import type { NotebookCell, NotebookDocument, NotebookGridSlot } from "videobook-engine";
import { NOTEBOOK_GRID_COLUMN_COUNT, NOTEBOOK_GRID_ROW_COUNT } from "videobook-engine/notebook-grid";

function readingOrder(left: NotebookCell, right: NotebookCell): number {
  return left.slot.row - right.slot.row || left.slot.column - right.slot.column || left.id.localeCompare(right.id);
}

export function arrangeGoalNotebook(
  document: NotebookDocument,
  reserve: Partial<Record<"generators" | "images" | "videos" | "timelines", number>> = {},
): NotebookDocument {
  const goals = document.cells.filter(cell => cell.type === "goal").sort(readingOrder);
  if (goals.length === 0) return document;
  const references = new Set(goals.flatMap(goal => Array.isArray(goal.inputs?.characters)
    ? goal.inputs.characters.flatMap((character: unknown) => character && typeof character === "object" && "cellId" in character && typeof character.cellId === "string" ? [character.cellId] : [])
    : []));
  const outputs = new Set(document.edges.filter(edge => document.cells.some(cell => cell.id === edge.source && cell.type === "generate_image")).map(edge => edge.target));
  const ordered = [...document.cells].sort((left, right) => left.id.localeCompare(right.id));
  const referenceImages = document.cells.filter(cell => cell.type === "image" && (references.has(cell.id)
    || !outputs.has(cell.id) && !cell.inputs?.producerCellId && !cell.inputs?.mediaRole)).sort(readingOrder);
  const referenceIds = new Set(referenceImages.map(cell => cell.id));
  const generators = ordered.filter(cell => cell.type.startsWith("generate_") || cell.type === "prompt");
  const images = ordered.filter(cell => cell.type === "image" && !referenceIds.has(cell.id));
  const videos = ordered.filter(cell => cell.type === "video");
  const timelines = document.cells.filter(cell => cell.type === "timeline").sort(readingOrder);
  const slots = new Map<string, NotebookGridSlot>();
  let row = 0;
  const place = (cells: NotebookCell[], extra = 0, minimumRows = 1): void => {
    cells.forEach((cell, index) => slots.set(cell.id, { row: row + Math.floor(index / NOTEBOOK_GRID_COLUMN_COUNT), column: index % NOTEBOOK_GRID_COLUMN_COUNT }));
    row += Math.max(minimumRows, Math.ceil((cells.length + extra) / NOTEBOOK_GRID_COLUMN_COUNT));
  };
  place(referenceImages, 0, 0);
  place([...goals, ...generators], reserve.generators);
  place(images, reserve.images);
  place(videos, reserve.videos);
  for (const timeline of timelines) {
    slots.set(timeline.id, { row, column: 0 });
    row += 1;
  }
  row += reserve.timelines ?? 0;
  place(ordered.filter(cell => !slots.has(cell.id)), 0, 0);
  if (row > NOTEBOOK_GRID_ROW_COUNT) throw new Error(`The goal layout needs ${row} rows, but the grid supports ${NOTEBOOK_GRID_ROW_COUNT}. Remove unused cells before continuing.`);
  return { ...document, cells: document.cells.map(cell => ({ ...cell, slot: slots.get(cell.id)! })) };
}
