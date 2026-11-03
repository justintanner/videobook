import type { NotebookCell, NotebookCellType, NotebookGridSlot } from "videobook-engine";
import {
  firstEmptyNotebookGridSlot,
  NOTEBOOK_GRID_COLUMN_COUNT,
  NOTEBOOK_GRID_FULL_ERROR,
  NOTEBOOK_GRID_ROW_COUNT,
  notebookOccupiedSlots,
} from "videobook-engine/notebook-grid";

export type NotebookLane = "source" | "gen" | "image" | "video" | "audio" | "work";

export const NOTEBOOK_LANE_ORDER = [
  "source",
  "gen",
  "image",
  "video",
  "audio",
  "work",
] as const satisfies readonly NotebookLane[];

export const NOTEBOOK_LANE_LABELS: Record<NotebookLane, string> = {
  source: "Source videos",
  gen: "Gen",
  image: "Images",
  video: "Videos",
  audio: "Audio",
  work: "Work",
};

export type NotebookLaneCell = Pick<NotebookCell, "id" | "type" | "slot">
  & Partial<Pick<NotebookCell, "inputs" | "outputArtifactId">>;

export interface NotebookGridCell {
  id: string;
  type: string;
  slot: NotebookGridSlot;
}

export interface NotebookLaneSlot {
  id: string;
  row: number;
  column: number;
}

export type NotebookLaneArrangement =
  | { ok: true; rowCount: number; slots: NotebookLaneSlot[] }
  | { ok: false; requiredRows: number };

export interface NotebookLanePlacement {
  slot: NotebookGridSlot;
  makeRoom: boolean;
}

type VideoLane = Extract<NotebookLane, "source" | "video">;

const LANE_BY_TYPE: Record<NotebookCellType, NotebookLane> = {
  analysis: "work",
  analyze: "work",
  audio: "audio",
  character: "work",
  concat: "video",
  extract_audio: "audio",
  generate_audio: "gen",
  generate_image: "gen",
  generate_video: "gen",
  goal: "gen",
  image: "image",
  post: "work",
  prompt: "gen",
  splice: "video",
  split_video: "video",
  timeline: "work",
  video: "source",
};

const GENERATED_VIDEO_ROLE = "generate-video-output";
const CLIP_VIDEO_ROLE = "cut-clip-output";
const IMPORTED_VIDEO_OPERATIONS: ReadonlySet<string> = new Set(["download_video"]);
const CLIP_VIDEO_OPERATIONS: ReadonlySet<string> = new Set(["extract_video_clip"]);
const COPY_VIDEO_OPERATIONS: ReadonlySet<string> = new Set(["duplicate_asset"]);

function stringInput(cell: NotebookLaneCell, key: string): string | undefined {
  const value = cell.inputs?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function isGeneratedVideo(cell: NotebookLaneCell): boolean {
  return stringInput(cell, "mediaRole") === GENERATED_VIDEO_ROLE
    || stringInput(cell, "producerCellId") !== undefined;
}

function derivedVideoFallback(cell: NotebookLaneCell): VideoLane | null {
  if (stringInput(cell, "mediaRole") === CLIP_VIDEO_ROLE) return "source";
  const operation = stringInput(cell, "sourceOperation");
  if (operation === undefined) return null;
  if (CLIP_VIDEO_OPERATIONS.has(operation)) return "source";
  return COPY_VIDEO_OPERATIONS.has(operation) ? "video" : null;
}

function isImportedVideo(cell: NotebookLaneCell): boolean {
  const operation = stringInput(cell, "sourceOperation");
  return operation === undefined || IMPORTED_VIDEO_OPERATIONS.has(operation);
}

function parentVideo(
  cell: NotebookLaneCell,
  cells: readonly NotebookLaneCell[],
  seen: ReadonlySet<string>,
): NotebookLaneCell | undefined {
  const sourceCellId = stringInput(cell, "sourceCellId");
  const artifactId = stringInput(cell, "sourceArtifactId") ?? stringInput(cell, "source_asset_id");
  const parent = (sourceCellId === undefined ? undefined : cells.find((candidate) => candidate.id === sourceCellId))
    ?? (artifactId === undefined
      ? undefined
      : cells.find((candidate) => candidate.id !== cell.id && candidate.outputArtifactId === artifactId));
  return parent?.type === "video" && !seen.has(parent.id) ? parent : undefined;
}

function videoLane(
  cell: NotebookLaneCell,
  cells: readonly NotebookLaneCell[],
  seen: ReadonlySet<string>,
): VideoLane {
  if (isGeneratedVideo(cell)) return "video";
  const fallback = derivedVideoFallback(cell);
  if (fallback === null) return isImportedVideo(cell) ? "source" : "video";
  const parent = parentVideo(cell, cells, seen);
  return parent ? videoLane(parent, cells, new Set([...seen, parent.id])) : fallback;
}

export function notebookTypeLane(type: NotebookCellType): NotebookLane {
  return LANE_BY_TYPE[type];
}

export function notebookCellLane(
  cell: NotebookLaneCell,
  cells: readonly NotebookLaneCell[] = [],
): NotebookLane {
  if (cell.type !== "video") return LANE_BY_TYPE[cell.type];
  return videoLane(cell, cells, new Set([cell.id]));
}

export function notebookLaneLabel(lane: NotebookLane): string {
  return NOTEBOOK_LANE_LABELS[lane];
}

function laneRank(lane: NotebookLane): number {
  return NOTEBOOK_LANE_ORDER.indexOf(lane);
}

function readingOrder(left: NotebookLaneCell, right: NotebookLaneCell): number {
  return left.slot.row - right.slot.row
    || left.slot.column - right.slot.column
    || left.id.localeCompare(right.id);
}

function slotKey(slot: NotebookGridSlot): string {
  return `${slot.row}:${slot.column}`;
}

function timelineRows(cells: readonly NotebookGridCell[]): Set<number> {
  return new Set(cells.filter((cell) => cell.type === "timeline").map((cell) => cell.slot.row));
}

function laneCellIds(cells: readonly NotebookLaneCell[]): Record<NotebookLane, string[]> {
  const ids: Record<NotebookLane, string[]> = {
    source: [],
    gen: [],
    image: [],
    video: [],
    audio: [],
    work: [],
  };
  for (const cell of [...cells].sort(readingOrder)) {
    if (cell.type === "timeline") continue;
    ids[notebookCellLane(cell, cells)].push(cell.id);
  }
  return ids;
}

function laneRowCount(cellCount: number): number {
  return Math.ceil(cellCount / NOTEBOOK_GRID_COLUMN_COUNT);
}

function laneRowsOf(ids: readonly string[]): string[][] {
  return Array.from(
    { length: laneRowCount(ids.length) },
    (_, index) => ids.slice(index * NOTEBOOK_GRID_COLUMN_COUNT, (index + 1) * NOTEBOOK_GRID_COLUMN_COUNT),
  );
}

export function arrangeNotebookLanes(
  cells: readonly NotebookLaneCell[],
): NotebookLaneArrangement {
  const timelines = cells.filter((cell) => cell.type === "timeline");
  const reserved = timelineRows(cells);
  const idsByLane = laneCellIds(cells);
  const requiredRows = NOTEBOOK_LANE_ORDER.reduce(
    (total, lane) => total + laneRowCount(idsByLane[lane].length),
    0,
  );
  if (requiredRows + reserved.size > NOTEBOOK_GRID_ROW_COUNT) return { ok: false, requiredRows };
  const slots: NotebookLaneSlot[] = timelines.map((cell) => ({ id: cell.id, ...cell.slot }));
  let nextRow = 0;
  for (const lane of NOTEBOOK_LANE_ORDER) {
    for (const ids of laneRowsOf(idsByLane[lane])) {
      while (reserved.has(nextRow)) nextRow += 1;
      ids.forEach((id, column) => slots.push({ id, row: nextRow, column }));
      nextRow += 1;
    }
  }
  return {
    ok: true,
    rowCount: Math.max(nextRow, ...timelines.map((cell) => cell.slot.row + 1)),
    slots,
  };
}

function notebookRowLanes(
  cells: readonly NotebookLaneCell[],
): Map<number, NotebookLane> {
  const lanes = new Map<number, NotebookLane>();
  for (const cell of [...cells].sort(readingOrder)) {
    if (cell.type === "timeline" || lanes.has(cell.slot.row)) continue;
    lanes.set(cell.slot.row, notebookCellLane(cell, cells));
  }
  return lanes;
}

function firstFreeLaneSlot(
  rowLanes: ReadonlyMap<number, NotebookLane>,
  lane: NotebookLane,
  occupied: ReadonlySet<string>,
): NotebookGridSlot | null {
  const rows = [...rowLanes].filter(([, rowLane]) => rowLane === lane).map(([row]) => row).sort((left, right) => left - right);
  for (const row of rows) {
    for (let column = 0; column < NOTEBOOK_GRID_COLUMN_COUNT; column += 1) {
      if (!occupied.has(slotKey({ row, column }))) return { row, column };
    }
  }
  return null;
}

function laneAnchorRow(
  rowLanes: ReadonlyMap<number, NotebookLane>,
  lane: NotebookLane,
): number {
  const rows = [...rowLanes];
  const own = rows.filter(([, rowLane]) => rowLane === lane).map(([row]) => row);
  if (own.length > 0) return Math.max(...own);
  const earlier = rows.filter(([, rowLane]) => laneRank(rowLane) < laneRank(lane)).map(([row]) => row);
  return Math.max(-1, ...earlier);
}

function nextOpenRow(row: number, reserved: ReadonlySet<number>): number {
  let candidate = row + 1;
  while (reserved.has(candidate)) candidate += 1;
  return candidate;
}

export function notebookRowOpening(
  cells: readonly NotebookGridCell[],
  row: number,
): Map<string, NotebookGridSlot> | null {
  const reserved = timelineRows(cells);
  if (reserved.has(row)) return null;
  const occupiedRows = new Set(cells.filter((cell) => cell.type !== "timeline").map((cell) => cell.slot.row));
  const shifted = new Map<number, number>();
  for (let current = row; occupiedRows.has(current);) {
    const target = nextOpenRow(current, reserved);
    if (target >= NOTEBOOK_GRID_ROW_COUNT) return null;
    shifted.set(current, target);
    current = target;
  }
  const moves = new Map<string, NotebookGridSlot>();
  for (const cell of cells) {
    const target = cell.type === "timeline" ? undefined : shifted.get(cell.slot.row);
    if (target !== undefined) moves.set(cell.id, { row: target, column: cell.slot.column });
  }
  return moves;
}

export function openNotebookRow<T extends NotebookGridCell>(
  cells: readonly T[],
  row: number,
): T[] {
  const moves = notebookRowOpening(cells, row);
  if (!moves) throw new Error(NOTEBOOK_GRID_FULL_ERROR);
  return cells.map((cell) => {
    const slot = moves.get(cell.id);
    return slot ? { ...cell, slot } : cell;
  });
}

export function notebookLanePlacement(
  cells: readonly NotebookLaneCell[],
  lane: NotebookLane,
): NotebookLanePlacement {
  const occupiedSlots = notebookOccupiedSlots(cells);
  const occupied = new Set(occupiedSlots.map(slotKey));
  const rowLanes = notebookRowLanes(cells);
  const free = firstFreeLaneSlot(rowLanes, lane, occupied);
  if (free) return { slot: free, makeRoom: false };
  const row = nextOpenRow(laneAnchorRow(rowLanes, lane), timelineRows(cells));
  const makeRoom = rowLanes.has(row);
  if (row < NOTEBOOK_GRID_ROW_COUNT && (!makeRoom || notebookRowOpening(cells, row))) {
    return { slot: { row, column: 0 }, makeRoom };
  }
  return { slot: firstEmptyNotebookGridSlot(occupiedSlots), makeRoom: false };
}

export function placeInNotebookLane<T extends NotebookLaneCell>(
  cells: readonly T[],
  lane: NotebookLane,
): { cells: T[]; slot: NotebookGridSlot } {
  const placement = notebookLanePlacement(cells, lane);
  return {
    cells: placement.makeRoom ? openNotebookRow(cells, placement.slot.row) : [...cells],
    slot: placement.slot,
  };
}
