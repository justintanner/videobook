import type { NotebookGridSlot } from "videobook-engine";
import {
  firstEmptyNotebookGridSlot,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_ROW_COUNT,
  notebookOccupiedSlots,
} from "videobook-engine/notebook-grid";
import {
  compareIds,
  compareRoundsInputs,
  generatorRoundsOf,
  isLinkedCell,
  notebookPromptKey,
  notebookRoundHeaderSlots,
  notebookRoundsModel,
  notebookSlotKey,
  roundsTakeIds,
  type GeneratorRounds,
  type NotebookRoundsModel,
  type RoundsCell,
  type RoundsDocument,
} from "./notebook-rounds.js";

export interface RoundsPlacement<T extends RoundsCell> {
  cells: T[];
  slot: NotebookGridSlot;
}

const PENDING_CELL = "rounds-pending-";

function cellsOf(model: NotebookRoundsModel, ids: readonly string[]): RoundsCell[] {
  return ids.flatMap((id) => {
    const cell = model.cellsById.get(id);
    return cell ? [cell] : [];
  });
}

function roundsAreaKeys(model: NotebookRoundsModel): string[] {
  return model.generators.filter((rounds) => rounds.rounds.length > 0).flatMap((rounds) => {
    const generator = model.cellsById.get(rounds.generatorId)!;
    const cells = [generator, ...cellsOf(model, roundsTakeIds(rounds))];
    const rows = cells.map((cell) => cell.slot.row);
    const columns = cells.map((cell) => cell.slot.column);
    const keys: string[] = [];
    for (let row = Math.min(...rows); row <= Math.max(...rows); row += 1) {
      for (let column = Math.min(...columns); column <= Math.max(...columns); column += 1) {
        keys.push(notebookSlotKey({ row, column }));
      }
    }
    return keys;
  });
}

function takenKeys(cells: readonly RoundsCell[], model: NotebookRoundsModel, areas = true): Set<string> {
  return new Set([
    ...notebookOccupiedSlots(cells).map(notebookSlotKey),
    ...notebookRoundHeaderSlots(model).map((header) => notebookSlotKey(header.slot)),
    ...(areas ? roundsAreaKeys(model) : []),
  ]);
}

function below(slot: NotebookGridSlot): NotebookGridSlot {
  return { row: slot.row + 1, column: slot.column };
}

function onBoard(slot: NotebookGridSlot): boolean {
  return slot.row < NOTEBOOK_GRID_ROW_COUNT && slot.column < NOTEBOOK_GRID_COLUMN_COUNT;
}

function firstFree<T extends RoundsCell>(cells: T[]): RoundsPlacement<T> {
  return { cells, slot: firstEmptyNotebookGridSlot(notebookOccupiedSlots(cells)) };
}

function moveCell<T extends RoundsCell>(cells: readonly T[], id: string, slot: NotebookGridSlot): T[] {
  return cells.map((cell) => (cell.id === id ? { ...cell, slot } : cell));
}

function shiftRowsDown<T extends RoundsCell>(cells: readonly T[], from: number, count: number): T[] | null {
  const lowest = Math.max(-1, ...cells.filter((cell) => cell.slot.row >= from).map((cell) => cell.slot.row));
  if (lowest + count >= NOTEBOOK_GRID_ROW_COUNT) return null;
  return cells.map((cell) => cell.slot.row >= from
    ? { ...cell, slot: { row: cell.slot.row + count, column: cell.slot.column } }
    : cell);
}

function foreignRow(cells: readonly RoundsCell[], model: NotebookRoundsModel, row: number, band: string | undefined): boolean {
  return cells.some((cell) => cell.slot.row === row
    && (cell.type === "timeline" || model.bandOf.get(cell.id) !== band));
}

function settleInBand<T extends RoundsCell>(
  cells: T[],
  model: NotebookRoundsModel,
  slot: NotebookGridSlot,
  band: string | undefined,
  areas = true,
): RoundsPlacement<T> | null {
  if (!onBoard(slot)) return null;
  if (!takenKeys(cells, model, areas).has(notebookSlotKey(slot)) && !foreignRow(cells, model, slot.row, band)) {
    return { cells, slot };
  }
  const shifted = shiftRowsDown(cells, slot.row, 1);
  return shifted ? { cells: shifted, slot } : null;
}

function lowestCell(cells: readonly RoundsCell[]): RoundsCell | undefined {
  return [...cells].sort((left, right) => right.slot.row - left.slot.row || compareIds(right.id, left.id))[0];
}

function bandBottom(cells: readonly RoundsCell[], model: NotebookRoundsModel, band: string): number {
  return Math.max(-1, ...cells.filter((cell) => model.bandOf.get(cell.id) === band).map((cell) => cell.slot.row));
}

function headsEmptyColumn(model: NotebookRoundsModel, generator: RoundsCell, rounds: GeneratorRounds): boolean {
  return !cellsOf(model, roundsTakeIds(rounds)).some((take) =>
    take.slot.column === generator.slot.column && take.slot.row > generator.slot.row);
}

function roundEdges(model: NotebookRoundsModel, generator: RoundsCell, rounds: GeneratorRounds): { left: number; right: number } {
  const columns = [generator, ...cellsOf(model, roundsTakeIds(rounds))].map((cell) => cell.slot.column);
  return { left: Math.min(...columns), right: Math.max(...columns) };
}

function wrapRound<T extends RoundsCell>(
  cells: T[],
  model: NotebookRoundsModel,
  generator: RoundsCell,
  column: number,
): RoundsPlacement<T> | null {
  const top = bandBottom(cells, model, generator.id) + 1;
  const crowded = cells.some((cell) => cell.slot.row === top || cell.slot.row === top + 1);
  const room = crowded ? shiftRowsDown(cells, top, 2) : cells;
  if (!room || top + 1 >= NOTEBOOK_GRID_ROW_COUNT) return null;
  return { cells: moveCell(room, generator.id, { row: top, column }), slot: { row: top + 1, column } };
}

function openRound<T extends RoundsCell>(
  cells: T[],
  model: NotebookRoundsModel,
  generator: RoundsCell,
  rounds: GeneratorRounds,
): RoundsPlacement<T> | null {
  const edges = roundEdges(model, generator, rounds);
  const head = { row: generator.slot.row, column: edges.right + 1 };
  const taken = takenKeys(cells, model, false);
  const fits = onBoard(head) && onBoard(below(head))
    && !taken.has(notebookSlotKey(head)) && !taken.has(notebookSlotKey(below(head)));
  if (fits) return { cells: moveCell(cells, generator.id, head), slot: below(head) };
  return wrapRound(cells, model, generator, edges.left);
}

export function placeGenerationTake<T extends RoundsCell>(
  document: RoundsDocument<T>,
  producerId: string,
): RoundsPlacement<T> {
  const cells = [...document.cells];
  const model = notebookRoundsModel(document);
  const generator = model.cellsById.get(producerId);
  const rounds = generatorRoundsOf(model, producerId);
  if (!generator || !rounds) return firstFree(cells);
  const key = notebookPromptKey(generator.prompt ?? "");
  const round = rounds.rounds.find((candidate) => candidate.key === key);
  const anchor = round
    ? lowestCell(cellsOf(model, round.takeIds))
    : headsEmptyColumn(model, generator, rounds) ? generator : undefined;
  const placed = anchor
    ? settleInBand(cells, model, below(anchor.slot), producerId, false)
    : openRound(cells, model, generator, rounds);
  return placed ?? firstFree(cells);
}

function finishPlacement<T extends RoundsCell>(
  cells: T[],
  model: NotebookRoundsModel,
  take: RoundsCell,
  generatorId: string,
): RoundsPlacement<T> | null {
  const generator = model.cellsById.get(generatorId);
  const rounds = generatorRoundsOf(model, generatorId);
  if (!generator || !rounds) return null;
  const start = roundEdges(model, generator, rounds).right + 1;
  if (start >= NOTEBOOK_GRID_COLUMN_COUNT) return null;
  const taken = takenKeys(cells, model);
  const bottom = bandBottom(cells, model, generatorId);
  for (let row = take.slot.row; row <= bottom; row += 1) {
    for (let column = start; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      if (!taken.has(notebookSlotKey({ row, column }))) return { cells, slot: { row, column } };
    }
  }
  return settleInBand(cells, model, { row: bottom + 1, column: start }, generatorId);
}

function siblingColumn(model: NotebookRoundsModel, anchor: RoundsCell): number {
  const rounds = new Set(roundsAreaKeys(model));
  const right = { row: anchor.slot.row, column: anchor.slot.column + 1 };
  const child = below(right);
  const blocked = rounds.has(notebookSlotKey(right)) || rounds.has(notebookSlotKey(child));
  return onBoard(child) && !blocked ? child.column : anchor.slot.column;
}

function besidePlacement<T extends RoundsCell>(
  cells: T[],
  model: NotebookRoundsModel,
  anchor: RoundsCell,
): RoundsPlacement<T> | null {
  const band = model.bandOf.get(anchor.id);
  const taken = takenKeys(cells, model);
  const right = { row: anchor.slot.row, column: anchor.slot.column + 1 };
  if (onBoard(right) && !taken.has(notebookSlotKey(right))) return { cells, slot: right };
  const column = siblingColumn(model, anchor);
  for (let row = anchor.slot.row + 1; row < NOTEBOOK_GRID_ROW_COUNT; row += 1) {
    const slot = { row, column };
    if (foreignRow(cells, model, row, band)) return settleInBand(cells, model, slot, band);
    if (!taken.has(notebookSlotKey(slot))) return { cells, slot };
  }
  return null;
}

function derivedPlacement<T extends RoundsCell>(
  document: RoundsDocument<T>,
  anchorId: string,
): RoundsPlacement<T> {
  const cells = [...document.cells];
  const model = notebookRoundsModel(document);
  const anchor = model.cellsById.get(anchorId);
  if (!anchor) return firstFree(cells);
  const owner = model.takeOwner.get(anchorId);
  const placed = (owner ? finishPlacement(cells, model, anchor, owner) : null)
    ?? besidePlacement(cells, model, anchor);
  return placed ?? firstFree(cells);
}

function pendingCell(index: number, source: RoundsCell, slot: NotebookGridSlot): RoundsCell {
  return { id: `${PENDING_CELL}${index}`, type: source.type, slot, inputs: { sourceCellId: source.id } };
}

export function placeDerivedCells<T extends RoundsCell>(
  document: RoundsDocument<T>,
  sourceId: string,
  count: number,
): { cells: T[]; slots: NotebookGridSlot[] } {
  const source = document.cells.find((cell) => cell.id === sourceId);
  if (!source) {
    const occupied = notebookOccupiedSlots(document.cells);
    const slots: NotebookGridSlot[] = [];
    for (let index = 0; index < count; index += 1) slots.push(firstEmptyNotebookGridSlot([...occupied, ...slots]));
    return { cells: [...document.cells], slots };
  }
  let working: RoundsCell[] = [...document.cells];
  for (let index = 0; index < count; index += 1) {
    const anchorId = index === 0 ? sourceId : `${PENDING_CELL}${index - 1}`;
    const placed = derivedPlacement({ cells: working, edges: document.edges }, anchorId);
    working = [...placed.cells, pendingCell(index, source, placed.slot)];
  }
  const slots = Array.from({ length: count }, (_, index) =>
    working.find((cell) => cell.id === `${PENDING_CELL}${index}`)!.slot);
  return { cells: working.filter((cell) => !cell.id.startsWith(PENDING_CELL)) as T[], slots };
}

export function placeDerivedCell<T extends RoundsCell>(
  document: RoundsDocument<T>,
  sourceId: string,
): RoundsPlacement<T> {
  const placed = placeDerivedCells(document, sourceId, 1);
  return { cells: placed.cells, slot: placed.slots[0]! };
}

function nextOpenRow(cells: readonly RoundsCell[]): number {
  const timelineRows = new Set(cells.filter((cell) => cell.type === "timeline").map((cell) => cell.slot.row));
  let row = Math.max(-1, ...cells.filter((cell) => cell.type !== "timeline").map((cell) => cell.slot.row)) + 1;
  while (timelineRows.has(row)) row += 1;
  return row;
}

function openRowSlot(cells: readonly RoundsCell[], column: number): NotebookGridSlot {
  const row = nextOpenRow(cells);
  return row < NOTEBOOK_GRID_ROW_COUNT
    ? { row, column }
    : firstEmptyNotebookGridSlot(notebookOccupiedSlots(cells));
}

function roundStartColumn(model: NotebookRoundsModel): number {
  const columns = model.generators.flatMap((rounds) =>
    cellsOf(model, [rounds.generatorId, ...roundsTakeIds(rounds)]).map((cell) => cell.slot.column));
  return Math.min(...columns);
}

export function placeNewGenerator(document: RoundsDocument, inputIds: readonly string[] = []): NotebookGridSlot {
  const model = notebookRoundsModel(document);
  const primary = inputIds
    .filter((id) => model.cellsById.has(id) && !model.bandOf.has(id))
    .sort(compareRoundsInputs(model.cellsById))[0];
  const anchor = primary === undefined ? undefined : model.cellsById.get(primary)!;
  const right = anchor ? { row: anchor.slot.row, column: anchor.slot.column + 1 } : null;
  if (right && onBoard(right) && !takenKeys(document.cells, model).has(notebookSlotKey(right))) return right;
  return openRowSlot(document.cells, model.generators.length > 0 ? roundStartColumn(model) : 0);
}

function looseRow(model: NotebookRoundsModel, cells: readonly RoundsCell[]): boolean {
  return cells.every((cell) => !model.bandOf.has(cell.id) && !isLinkedCell(model, cell.id));
}

export function placeLooseCell(document: RoundsDocument): NotebookGridSlot {
  const model = notebookRoundsModel(document);
  const content = document.cells.filter((cell) => cell.type !== "timeline");
  const lastRow = Math.max(-1, ...content.map((cell) => cell.slot.row));
  const rowCells = content.filter((cell) => cell.slot.row === lastRow);
  if (rowCells.length > 0 && looseRow(model, rowCells)) {
    const taken = takenKeys(document.cells, model);
    const after = Math.max(...rowCells.map((cell) => cell.slot.column)) + 1;
    for (let column = after; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      if (!taken.has(notebookSlotKey({ row: lastRow, column }))) return { row: lastRow, column };
    }
  }
  return openRowSlot(document.cells, 0);
}
