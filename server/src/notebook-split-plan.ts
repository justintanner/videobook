import { v7 as uuidv7 } from "uuid";
import { nextVerticalSlotFrom, notebookGridTag, notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import type { NotebookCell, NotebookDocument, NotebookEdge, NotebookGridSlot } from "videobook-engine";

export type NotebookSplitOutputMode = "all" | "keep" | "remove";

export type NotebookSplitRange = {
  endSeconds: number;
  startSeconds: number;
};

type NotebookSplitOutputGroup = NotebookSplitRange[];

export type NotebookSplitOutputDraft = {
  chunkIndex: number;
  endSeconds: number;
  outputCell: NotebookCell;
  startSeconds: number;
};

export type NotebookSplitDraft = {
  actionCell: NotebookCell;
  createdCellIds: string[];
  cutPointsSeconds: number[];
  document: NotebookDocument;
  outputs: NotebookSplitOutputDraft[];
  sourceCellId: string;
  sourceAddress: string;
};

export const minimumSplitPieceSeconds = 0.02;

export function roundedSplitSeconds(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function formatSplitTimestamp(value: number): string {
  const totalMilliseconds = Math.max(0, Math.round(value * 1000));
  const minutes = Math.floor(totalMilliseconds / 60_000);
  const seconds = (totalMilliseconds - minutes * 60_000) / 1000;
  return `${minutes}:${seconds.toFixed(3).padStart(6, "0")}`;
}

function splitSlots(
  cells: readonly NotebookCell[],
  outputCount: number,
  sourceSlot: NotebookGridSlot,
): { action: NotebookGridSlot; outputs: NotebookGridSlot[] } {
  const occupied = notebookOccupiedSlots(cells);
  const action = nextVerticalSlotFrom(sourceSlot, occupied);
  const outputs: NotebookGridSlot[] = [];
  let cursor = action;
  for (let index = 0; index < outputCount; index += 1) {
    const slot = nextVerticalSlotFrom(cursor, [...occupied, action, ...outputs]);
    outputs.push(slot);
    cursor = slot;
  }
  return { action, outputs };
}

function assertSplitOutputRanges(ranges: readonly NotebookSplitRange[]): void {
  for (const range of ranges) {
    const duration = roundedSplitSeconds(range.endSeconds - range.startSeconds);
    if (!(duration >= minimumSplitPieceSeconds)) {
      throw new Error(`Keep at least ${minimumSplitPieceSeconds}s in every output range`);
    }
  }
}

export function notebookSplitPieces(input: {
  cutPointsSeconds: readonly number[];
  sourceDurationSeconds: number;
}): NotebookSplitRange[] {
  const duration = roundedSplitSeconds(input.sourceDurationSeconds);
  if (!Number.isFinite(duration) || duration < minimumSplitPieceSeconds) {
    throw new Error(`Video must be at least ${minimumSplitPieceSeconds}s long to split`);
  }
  const requested = input.cutPointsSeconds.length > 0 ? input.cutPointsSeconds : [duration / 2];
  const cutPoints = requested
    .map((value) => roundedSplitSeconds(value))
    .sort((left, right) => left - right);
  if (cutPoints.some((value) => !Number.isFinite(value))) {
    throw new Error("Split times must be finite numbers");
  }
  const boundaries = [0, ...cutPoints, duration];
  const pieces = boundaries.slice(0, -1).map((startSeconds, index) => ({
    endSeconds: boundaries[index + 1]!,
    startSeconds,
  }));
  for (const piece of pieces) {
    if (!(piece.endSeconds > piece.startSeconds)) {
      throw new Error(`Keep at least ${minimumSplitPieceSeconds}s in every output range`);
    }
  }
  return pieces;
}

export function notebookSplitCutPoints(input: {
  cutPointsSeconds: readonly number[];
  sourceDurationSeconds: number;
}): number[] {
  const pieces = notebookSplitPieces(input);
  assertSplitOutputRanges(pieces);
  return pieces.slice(0, -1).map((piece) => piece.endSeconds);
}

export function notebookSplitRanges(input: {
  cutPointsSeconds: readonly number[];
  sourceDurationSeconds: number;
}): NotebookSplitRange[] {
  const pieces = notebookSplitPieces(input);
  assertSplitOutputRanges(pieces);
  return pieces;
}

function selectedPieces(
  pieces: readonly NotebookSplitRange[],
  selectedChunkIndexes: readonly number[] | undefined,
): Set<number> {
  const selected = new Set(
    (selectedChunkIndexes ?? [0]).filter((index) =>
      Number.isSafeInteger(index) && index >= 0 && index < pieces.length),
  );
  if (selected.size === 0) selected.add(0);
  return selected;
}

function removeOutputs(pieces: readonly NotebookSplitRange[], selected: Set<number>): NotebookSplitOutputGroup[] {
  const remaining = pieces.filter((_, index) => !selected.has(index));
  if (remaining.length === 0) throw new Error("Remove leaves nothing to keep");
  const total = remaining.reduce((sum, piece) => sum + (piece.endSeconds - piece.startSeconds), 0);
  assertSplitOutputRanges([{
    startSeconds: remaining[0]!.startSeconds,
    endSeconds: remaining[0]!.startSeconds + total,
  }]);
  return [remaining];
}

export function compileNotebookSplitOutputs(input: {
  cutPointsSeconds: readonly number[];
  outputMode?: NotebookSplitOutputMode;
  selectedChunkIndexes?: readonly number[];
  sourceDurationSeconds: number;
}): NotebookSplitOutputGroup[] {
  const pieces = notebookSplitPieces({
    cutPointsSeconds: input.cutPointsSeconds,
    sourceDurationSeconds: input.sourceDurationSeconds,
  });
  const mode = input.outputMode ?? "all";
  if (mode === "all") {
    assertSplitOutputRanges(pieces);
    return pieces.map((piece) => [piece]);
  }
  const selected = selectedPieces(pieces, input.selectedChunkIndexes);
  if (mode === "remove") return removeOutputs(pieces, selected);
  const kept = pieces.filter((_, index) => selected.has(index));
  if (kept.length === 0) throw new Error("Keep at least one split piece");
  assertSplitOutputRanges(kept);
  return kept.map((piece) => [piece]);
}

export function notebookSplitSummary(input: {
  cutPointsSeconds: readonly number[];
  outputMode?: NotebookSplitOutputMode;
  selectedChunkIndexes?: readonly number[];
  sourceAddress: string;
  sourceDurationSeconds: number;
}): string {
  const mode = input.outputMode ?? "all";
  const pieces = notebookSplitPieces({
    cutPointsSeconds: input.cutPointsSeconds,
    sourceDurationSeconds: input.sourceDurationSeconds,
  });
  if (mode === "all") return `Split ${input.sourceAddress} into ${pieces.length} chunks`;
  const selectedIndex = input.selectedChunkIndexes?.[0] ?? 0;
  const piece = pieces[selectedIndex] ?? pieces[0]!;
  const range = `${formatSplitTimestamp(piece.startSeconds)}-${formatSplitTimestamp(piece.endSeconds)}`;
  return mode === "keep"
    ? `Cut ${range} out of ${input.sourceAddress}`
    : `Remove ${range} from ${input.sourceAddress}`;
}

function outputLabel(mode: NotebookSplitOutputMode, group: NotebookSplitOutputGroup, chunkIndex: number): string {
  if (mode === "all") return `Chunk ${String(chunkIndex + 1).padStart(2, "0")}`;
  if (mode === "keep") {
    const range = group[0]!;
    return `Cut ${formatSplitTimestamp(range.startSeconds)}-${formatSplitTimestamp(range.endSeconds)}`;
  }
  const first = group[0]!;
  const last = group[group.length - 1]!;
  const removedStart = first.endSeconds;
  const removedEnd = last.startSeconds;
  if (group.length >= 2 && removedEnd > removedStart) {
    return `Without ${formatSplitTimestamp(removedStart)}-${formatSplitTimestamp(removedEnd)}`;
  }
  return `Without ${formatSplitTimestamp(first.startSeconds)}-${formatSplitTimestamp(last.endSeconds)}`;
}

function outputCellFor(input: {
  actionCell: NotebookCell;
  chunkCount: number;
  chunkIndex: number;
  group: NotebookSplitOutputGroup;
  mode: NotebookSplitOutputMode;
  slot: NotebookGridSlot;
  source: NotebookCell;
}): NotebookSplitOutputDraft {
  const { group } = input;
  const startSeconds = group[0]!.startSeconds;
  const joinedEnd = group.reduce((end, range) => end + (range.endSeconds - range.startSeconds), startSeconds);
  const endSeconds = group.length === 1 ? group[0]!.endSeconds : joinedEnd;
  const outputCell: NotebookCell = {
    id: uuidv7(),
    type: "video",
    label: outputLabel(input.mode, group, input.chunkIndex),
    slot: input.slot,
    inputs: {
      chunkCount: input.chunkCount,
      chunkIndex: input.chunkIndex,
      endSeconds,
      mediaRole: "split-video-output",
      producerCellId: input.actionCell.id,
      sourceCellId: input.source.id,
      startSeconds,
      state: "pending",
    },
  };
  return { chunkIndex: input.chunkIndex, endSeconds, outputCell, startSeconds };
}

function actionLabel(input: {
  cutPointsSeconds: number[];
  groupCount: number;
  mode: NotebookSplitOutputMode;
  selectedChunkIndexes: number[];
  source: NotebookCell;
  sourceDurationSeconds: number;
}): string {
  if (input.mode === "all") return `Split into ${input.groupCount} chunks`;
  return notebookSplitSummary({
    cutPointsSeconds: input.cutPointsSeconds,
    outputMode: input.mode,
    selectedChunkIndexes: input.selectedChunkIndexes.length > 0 ? input.selectedChunkIndexes : [0],
    sourceAddress: notebookGridTag(input.source.slot),
    sourceDurationSeconds: input.sourceDurationSeconds,
  });
}

function splitEdges(source: NotebookCell, actionCell: NotebookCell, outputs: readonly NotebookSplitOutputDraft[]): NotebookEdge[] {
  return [
    { id: uuidv7(), source: source.id, target: actionCell.id, targetInput: "video" },
    ...outputs.map((output) => ({
      id: uuidv7(),
      source: actionCell.id,
      target: output.outputCell.id,
      targetInput: "media",
    })),
  ];
}

export function planNotebookSplit(input: {
  cutPointsSeconds: readonly number[];
  document: NotebookDocument;
  outputMode?: NotebookSplitOutputMode;
  selectedChunkIndexes?: number[];
  source: NotebookCell;
  sourceDurationSeconds: number;
}): NotebookSplitDraft {
  const { source } = input;
  if (!Number.isFinite(input.sourceDurationSeconds) || input.sourceDurationSeconds <= 0) {
    throw new Error(
      `${notebookGridTag(source.slot)} does not have a usable duration yet; wait for video processing to finish`,
    );
  }
  const mode = input.outputMode ?? "all";
  const selectedChunkIndexes = input.selectedChunkIndexes ?? [];
  const groups = compileNotebookSplitOutputs({
    cutPointsSeconds: input.cutPointsSeconds,
    outputMode: mode,
    selectedChunkIndexes,
    sourceDurationSeconds: input.sourceDurationSeconds,
  });
  const cutPointsSeconds = notebookSplitPieces({
    cutPointsSeconds: input.cutPointsSeconds,
    sourceDurationSeconds: input.sourceDurationSeconds,
  }).slice(0, -1).map((piece) => piece.endSeconds);
  const slots = splitSlots(input.document.cells, groups.length, source.slot);
  const outputsSeconds = groups.map((group) => group.map((range) => ({
    endSeconds: range.endSeconds,
    startSeconds: range.startSeconds,
  })));
  const actionCell: NotebookCell = {
    id: uuidv7(),
    type: "split_video",
    label: actionLabel({
      cutPointsSeconds,
      groupCount: groups.length,
      mode,
      selectedChunkIndexes,
      source,
      sourceDurationSeconds: input.sourceDurationSeconds,
    }),
    slot: slots.action,
    provider: "local",
    operation: mode === "all" ? "split_at_points" : "split_ranges",
    tool: "ffmpeg",
    inputs: {
      cutPointsSeconds,
      endSeconds: input.sourceDurationSeconds,
      sourceCellId: source.id,
      sourceDurationSeconds: input.sourceDurationSeconds,
      startSeconds: 0,
      state: "ready",
      ...(mode === "all" ? {} : { outputsSeconds, selectedChunkIndexes }),
    },
  };
  const outputs = groups.map((group, chunkIndex) => outputCellFor({
    actionCell,
    chunkCount: groups.length,
    chunkIndex,
    group,
    mode,
    slot: slots.outputs[chunkIndex]!,
    source,
  }));
  const createdCells = [actionCell, ...outputs.map((output) => output.outputCell)];
  return {
    actionCell,
    createdCellIds: createdCells.map((cell) => cell.id),
    cutPointsSeconds,
    document: {
      ...input.document,
      cells: [...input.document.cells, ...createdCells],
      edges: [...input.document.edges, ...splitEdges(source, actionCell, outputs)],
    },
    outputs,
    sourceCellId: source.id,
    sourceAddress: notebookGridTag(source.slot),
  };
}
