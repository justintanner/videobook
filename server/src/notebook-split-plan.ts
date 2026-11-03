
export type NotebookSplitOutputMode = "all" | "keep" | "remove";

export type NotebookSplitRange = {
  endSeconds: number;
  startSeconds: number;
};

type NotebookSplitOutputGroup = NotebookSplitRange[];

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
