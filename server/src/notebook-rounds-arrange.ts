import type { NotebookGridSlot } from "videobook-engine";
import { NOTEBOOK_GRID_COLUMN_COUNT, NOTEBOOK_GRID_ROW_COUNT } from "videobook-engine/notebook-grid";
import {
  compareIds,
  compareRoundsInputs,
  isLinkedCell,
  notebookRoundsModel,
  roundsTakeIds,
  type GeneratorRounds,
  type NotebookRoundsModel,
  type RoundsCell,
  type RoundsDocument,
} from "./notebook-rounds.js";

const MAX_INPUT_COLUMNS = 3;
const MAX_FINISH_COLUMNS = 3;

export interface NotebookRoundsSlot {
  id: string;
  row: number;
  column: number;
}

export type NotebookRoundsArrangement =
  | { ok: true; rowCount: number; slots: NotebookRoundsSlot[] }
  | { ok: false; requiredRows: number };

interface Board {
  slots: Map<string, NotebookGridSlot>;
  taken: Set<string>;
}

interface TreeRow {
  depth: number;
  ids: string[];
}

interface RoundColumn {
  takeIds: readonly string[];
  generator: boolean;
}

interface TakeFinishes {
  takeId: string;
  rows: TreeRow[];
}

function slotKey(row: number, column: number): string {
  return `${row}:${column}`;
}

function place(board: Board, id: string, row: number, column: number): void {
  board.slots.set(id, { row, column });
  board.taken.add(slotKey(row, column));
}

function runIsFree(board: Board, row: number, column: number, length: number): boolean {
  return Array.from({ length }, (_, offset) => column + offset)
    .every((candidate) => candidate < NOTEBOOK_GRID_COLUMN_COUNT && !board.taken.has(slotKey(row, candidate)));
}

function firstRowWithRun(board: Board, from: number, column: number, length: number): number {
  let row = from;
  while (!runIsFree(board, row, column, length)) row += 1;
  return row;
}

function treeRows(
  roots: readonly string[],
  childrenOf: (id: string) => readonly string[],
  visited: Set<string> = new Set(),
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (id: string, depth: number, row: TreeRow | null): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const current = row ?? { depth, ids: [] };
    if (!row) rows.push(current);
    current.ids.push(id);
    childrenOf(id)
      .filter((child) => !visited.has(child))
      .forEach((child, index) => walk(child, depth + 1, index === 0 ? current : null));
  };
  roots.forEach((root) => walk(root, 0, null));
  return rows;
}

function rowRuns(ids: readonly string[], start: number, base: number): Array<{ column: number; ids: string[] }> {
  const runs: Array<{ column: number; ids: string[] }> = [];
  let column = Math.min(start, NOTEBOOK_GRID_COLUMN_COUNT - 1);
  let rest = [...ids];
  while (rest.length > 0) {
    const capacity = Math.max(1, NOTEBOOK_GRID_COLUMN_COUNT - column);
    runs.push({ column, ids: rest.slice(0, capacity) });
    rest = rest.slice(capacity);
    column = base;
  }
  return runs;
}

function extendChain(
  start: string,
  parentsIn: (id: string) => string[],
  visited: Set<string>,
  queue: string[],
): string[] {
  const chain = [start];
  let current = start;
  let [primary, ...branches] = parentsIn(current).filter((id) => !visited.has(id));
  while (primary !== undefined) {
    queue.push(...branches);
    visited.add(primary);
    chain.unshift(primary);
    current = primary;
    [primary, ...branches] = parentsIn(current).filter((id) => !visited.has(id));
  }
  return chain;
}

function inputChains(model: NotebookRoundsModel, generatorId: string): string[][] {
  const inputs = new Set(model.inputsOf.get(generatorId) ?? []);
  const compare = compareRoundsInputs(model.cellsById);
  const parentsIn = (id: string) => (model.parents.get(id) ?? []).filter((parent) => inputs.has(parent)).sort(compare);
  const visited = new Set<string>();
  const queue = parentsIn(generatorId);
  const chains: string[][] = [];
  while (queue.length > 0) {
    const start = queue.shift()!;
    if (visited.has(start)) continue;
    visited.add(start);
    chains.push(extendChain(start, parentsIn, visited, queue));
  }
  return chains;
}

function chainRows(chain: readonly string[], width: number): string[][] {
  const rows: string[][] = [];
  for (let end = chain.length; end > 0; end -= width) rows.push(chain.slice(Math.max(0, end - width), end));
  return rows;
}

function sharedInputWidth(model: NotebookRoundsModel): number {
  const longest = Math.max(0, ...model.generators.flatMap((rounds) =>
    inputChains(model, rounds.generatorId).map((chain) => chain.length)));
  return Math.min(MAX_INPUT_COLUMNS, longest);
}

function roundColumns(rounds: GeneratorRounds): RoundColumn[] {
  const columns = rounds.rounds.map((round, index) => ({
    takeIds: round.takeIds,
    generator: index === rounds.currentRound,
  }));
  return rounds.currentRound === -1 ? [...columns, { takeIds: [], generator: true }] : columns;
}

function finishRows(model: NotebookRoundsModel, rounds: GeneratorRounds): TakeFinishes[] {
  const finishes = new Set(model.finishesOf.get(rounds.generatorId) ?? []);
  const childrenIn = (id: string) => (model.children.get(id) ?? []).filter((child) => finishes.has(child)).sort();
  const visited = new Set<string>();
  return roundsTakeIds(rounds)
    .map((takeId) => ({ takeId, rows: treeRows(childrenIn(takeId), childrenIn, visited) }))
    .filter((entry) => entry.rows.length > 0);
}

function finishWidth(finishes: readonly TakeFinishes[], inputWidth: number): number {
  const widest = Math.max(0, ...finishes.flatMap((entry) => entry.rows.map((row) => row.depth + row.ids.length)));
  return Math.min(MAX_FINISH_COLUMNS, NOTEBOOK_GRID_COLUMN_COUNT - inputWidth - 1, widest);
}

function placeRoundColumn(board: Board, generatorId: string, column: RoundColumn, row: number, x: number): void {
  if (column.generator) place(board, generatorId, row, x);
  else board.taken.add(slotKey(row, x));
  column.takeIds.forEach((takeId, index) => place(board, takeId, row + 1 + index, x));
}

function placeRoundGroups(
  board: Board,
  generatorId: string,
  columns: readonly RoundColumn[],
  top: number,
  start: number,
  available: number,
): number {
  let row = top;
  for (let first = 0; first < columns.length; first += available) {
    const group = columns.slice(first, first + available);
    group.forEach((column, index) => placeRoundColumn(board, generatorId, column, row, start + index));
    row += 1 + Math.max(0, ...group.map((column) => column.takeIds.length));
  }
  return row;
}

function placeInputs(board: Board, model: NotebookRoundsModel, generatorId: string, top: number, width: number): number {
  if (width === 0) return top;
  const rows = inputChains(model, generatorId).flatMap((chain) => chainRows(chain, width));
  rows.forEach((ids, index) => ids.forEach((id, offset) => place(board, id, top + index, width - ids.length + offset)));
  return top + rows.length;
}

function readingOrder(board: Board): (left: TakeFinishes, right: TakeFinishes) => number {
  return (left, right) => {
    const leftSlot = board.slots.get(left.takeId)!;
    const rightSlot = board.slots.get(right.takeId)!;
    return leftSlot.row - rightSlot.row || leftSlot.column - rightSlot.column;
  };
}

function placeFinishes(board: Board, finishes: readonly TakeFinishes[], start: number): number {
  let bottom = 0;
  for (const { takeId, rows } of [...finishes].sort(readingOrder(board))) {
    const takeRow = board.slots.get(takeId)!.row;
    for (const treeRow of rows) {
      for (const run of rowRuns(treeRow.ids, start + treeRow.depth, start)) {
        const row = firstRowWithRun(board, takeRow, run.column, run.ids.length);
        run.ids.forEach((id, offset) => place(board, id, row, run.column + offset));
        bottom = Math.max(bottom, row + 1);
      }
    }
  }
  return bottom;
}

function layoutBand(
  board: Board,
  model: NotebookRoundsModel,
  rounds: GeneratorRounds,
  top: number,
  inputWidth: number,
): number {
  const columns = roundColumns(rounds);
  const finishes = finishRows(model, rounds);
  const available = NOTEBOOK_GRID_COLUMN_COUNT - inputWidth - finishWidth(finishes, inputWidth);
  const groupsBottom = placeRoundGroups(board, rounds.generatorId, columns, top, inputWidth, available);
  const inputsBottom = placeInputs(board, model, rounds.generatorId, top, inputWidth);
  const finishBottom = placeFinishes(board, finishes, inputWidth + Math.min(columns.length, available));
  return Math.max(groupsBottom, inputsBottom, finishBottom);
}

function leftoverComponents(model: NotebookRoundsModel, ids: readonly string[]): string[][] {
  const remaining = new Set(ids);
  const components: string[][] = [];
  for (const id of [...ids].sort()) {
    if (!remaining.has(id)) continue;
    remaining.delete(id);
    const component = [id];
    for (let index = 0; index < component.length; index += 1) {
      const current = component[index]!;
      for (const next of [...(model.parents.get(current) ?? []), ...(model.children.get(current) ?? [])]) {
        if (!remaining.has(next)) continue;
        remaining.delete(next);
        component.push(next);
      }
    }
    components.push(component);
  }
  return components;
}

function placeComponent(board: Board, model: NotebookRoundsModel, component: readonly string[], top: number): number {
  const members = new Set(component);
  const childrenIn = (id: string) => (model.children.get(id) ?? []).filter((child) => members.has(child)).sort();
  const roots = component.filter((id) => !(model.parents.get(id) ?? []).some((parent) => members.has(parent))).sort();
  let row = top;
  for (const treeRow of treeRows([...roots, ...[...component].sort()], childrenIn)) {
    for (const run of rowRuns(treeRow.ids, treeRow.depth, 0)) {
      run.ids.forEach((id, offset) => place(board, id, row, run.column + offset));
      row += 1;
    }
  }
  return row;
}

function byReadingOrder(left: RoundsCell, right: RoundsCell): number {
  return left.slot.row - right.slot.row || left.slot.column - right.slot.column || compareIds(left.id, right.id);
}

function placeRest(board: Board, model: NotebookRoundsModel, cells: readonly RoundsCell[], top: number): number {
  const rest = cells.filter((cell) => cell.type !== "timeline" && !board.slots.has(cell.id));
  const components = leftoverComponents(model, rest.filter((cell) => isLinkedCell(model, cell.id)).map((cell) => cell.id));
  let row = top;
  const singles = new Set(components.filter((component) => component.length === 1).flat());
  for (const component of components.filter((candidate) => candidate.length > 1)) {
    row = placeComponent(board, model, component, row);
  }
  const loose = rest.filter((cell) => singles.has(cell.id) || !isLinkedCell(model, cell.id)).sort(byReadingOrder);
  loose.forEach((cell, index) => place(board, cell.id, row + Math.floor(index / NOTEBOOK_GRID_COLUMN_COUNT), index % NOTEBOOK_GRID_COLUMN_COUNT));
  return row + Math.ceil(loose.length / NOTEBOOK_GRID_COLUMN_COUNT);
}

function placeTimelines(board: Board, cells: readonly RoundsCell[], top: number): number {
  const timelines = cells.filter((cell) => cell.type === "timeline").sort(byReadingOrder);
  timelines.forEach((cell, index) => place(board, cell.id, top + index, 0));
  return top + timelines.length;
}

export function arrangeNotebookRounds(document: RoundsDocument): NotebookRoundsArrangement {
  const model = notebookRoundsModel(document);
  const board: Board = { slots: new Map(), taken: new Set() };
  const inputWidth = sharedInputWidth(model);
  let row = 0;
  for (const rounds of model.generators) row = layoutBand(board, model, rounds, row, inputWidth);
  row = placeRest(board, model, document.cells, row);
  row = placeTimelines(board, document.cells, row);
  if (row > NOTEBOOK_GRID_ROW_COUNT) return { ok: false, requiredRows: row };
  return {
    ok: true,
    rowCount: row,
    slots: [...board.slots].map(([id, slot]) => ({ id, ...slot })),
  };
}
