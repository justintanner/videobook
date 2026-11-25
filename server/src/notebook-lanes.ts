import type { NotebookCell, NotebookCellType, NotebookGridSlot } from "videobook-engine";
import { NOTEBOOK_GRID_FULL_ERROR, NOTEBOOK_GRID_ROW_COUNT } from "videobook-engine/notebook-grid";

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

function timelineRows(cells: readonly NotebookGridCell[]): Set<number> {
  return new Set(cells.filter((cell) => cell.type === "timeline").map((cell) => cell.slot.row));
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
