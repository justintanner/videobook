export type VideoRange = {
  startSeconds: number;
  endSeconds: number;
};

export type TrimRequest = {
  keepStart?: number;
  keepEnd?: number;
  cuts?: readonly VideoRange[];
  headSeconds?: number;
  tailSeconds?: number;
};

const MINIMUM_CUT_PIECE_SECONDS = 0.02;

function rounded(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function hasKeepRange(request: TrimRequest): boolean {
  return request.keepStart !== undefined || request.keepEnd !== undefined;
}

function hasEdgeTrim(request: TrimRequest): boolean {
  return request.headSeconds !== undefined || request.tailSeconds !== undefined;
}

function trimModeCount(request: TrimRequest): number {
  return [hasKeepRange(request), (request.cuts?.length ?? 0) > 0, hasEdgeTrim(request)]
    .filter(Boolean).length;
}

function keepRangeCuts(request: TrimRequest, duration: number): VideoRange[] {
  const start = request.keepStart ?? 0;
  const end = Math.min(request.keepEnd ?? duration, duration);
  if (start < 0 || end <= start) throw new Error("The kept range must start before it ends");
  return [
    { startSeconds: 0, endSeconds: start },
    { startSeconds: end, endSeconds: duration },
  ];
}

function edgeCuts(request: TrimRequest, duration: number): VideoRange[] {
  const head = request.headSeconds ?? 0;
  const tail = request.tailSeconds ?? 0;
  if (head < 0 || tail < 0) throw new Error("head_seconds and tail_seconds must be >= 0");
  return [
    { startSeconds: 0, endSeconds: head },
    { startSeconds: duration - tail, endSeconds: duration },
  ];
}

function nonEmpty(range: VideoRange): boolean {
  return range.endSeconds > range.startSeconds;
}

function requestedCuts(request: TrimRequest, duration: number): VideoRange[] {
  if (hasKeepRange(request)) return keepRangeCuts(request, duration).filter(nonEmpty);
  if (hasEdgeTrim(request)) return edgeCuts(request, duration).filter(nonEmpty);
  return [...(request.cuts ?? [])];
}

function clampedCut(cut: VideoRange, duration: number): VideoRange | null {
  if (!Number.isFinite(cut.startSeconds) || !Number.isFinite(cut.endSeconds)) {
    throw new Error("Cut times must be finite numbers");
  }
  if (cut.startSeconds < 0 || cut.endSeconds <= cut.startSeconds) {
    throw new Error("Each cut must start at or after 0 and before it ends");
  }
  if (cut.startSeconds >= duration) throw new Error(`A cut starts after the video ends (${rounded(duration)}s)`);
  const range = { startSeconds: rounded(cut.startSeconds), endSeconds: rounded(Math.min(cut.endSeconds, duration)) };
  return range.endSeconds - range.startSeconds > 0 ? range : null;
}

function mergedCuts(cuts: readonly VideoRange[]): VideoRange[] {
  const sorted = [...cuts].sort((left, right) => left.startSeconds - right.startSeconds);
  return sorted.reduce<VideoRange[]>((merged, cut) => {
    const last = merged.at(-1);
    if (last && cut.startSeconds <= last.endSeconds) {
      return [...merged.slice(0, -1), { ...last, endSeconds: Math.max(last.endSeconds, cut.endSeconds) }];
    }
    return [...merged, cut];
  }, []);
}

function keepRangesAfterCuts(cuts: readonly VideoRange[], durationSeconds: number): VideoRange[] {
  const duration = rounded(durationSeconds);
  const boundaries = mergedCuts(cuts);
  const keeps: VideoRange[] = [];
  let cursor = 0;
  for (const cut of boundaries) {
    if (cut.startSeconds > cursor) keeps.push({ startSeconds: cursor, endSeconds: cut.startSeconds });
    cursor = Math.max(cursor, cut.endSeconds);
  }
  if (duration > cursor) keeps.push({ startSeconds: cursor, endSeconds: duration });
  return keeps.filter((range) => range.endSeconds - range.startSeconds >= MINIMUM_CUT_PIECE_SECONDS);
}

export function cutRangesOutside(keeps: readonly VideoRange[], durationSeconds: number): VideoRange[] {
  const bounds = [0, ...keeps.flatMap((keep) => [keep.startSeconds, keep.endSeconds]), rounded(durationSeconds)];
  const cuts: VideoRange[] = [];
  for (let index = 0; index < bounds.length; index += 2) {
    const [startSeconds, endSeconds] = [bounds[index]!, bounds[index + 1]!];
    if (endSeconds > startSeconds) cuts.push({ startSeconds, endSeconds });
  }
  return cuts;
}

export function trimKeepRanges(request: TrimRequest, durationSeconds: number): VideoRange[] {
  if (!(durationSeconds > 0)) throw new Error("The video has no usable duration yet");
  const modes = trimModeCount(request);
  if (modes === 0) {
    throw new Error("Pass trim_start/trim_end, cut_start/cut_end, cuts, or head_seconds/tail_seconds");
  }
  if (modes > 1) {
    throw new Error("Use one trim mode at a time: a kept range, removed ranges, or head/tail seconds");
  }
  const cuts = requestedCuts(request, durationSeconds)
    .map((cut) => clampedCut(cut, durationSeconds))
    .filter((cut): cut is VideoRange => cut !== null);
  if (cuts.length === 0) throw new Error("The trim removes nothing");
  const keeps = keepRangesAfterCuts(cuts, durationSeconds);
  if (keeps.length === 0) throw new Error("The trim would remove the whole video");
  return keeps;
}

export function cutPointPieces(cutPointsSeconds: readonly number[], durationSeconds: number): VideoRange[] {
  const duration = rounded(durationSeconds);
  if (!(duration >= MINIMUM_CUT_PIECE_SECONDS)) throw new Error("The video has no usable duration yet");
  const points = [...new Set(cutPointsSeconds.map(rounded))]
    .filter((point) => point > 0 && point < duration)
    .sort((left, right) => left - right);
  if (points.length === 0) throw new Error(`Split times must fall inside the video (0-${duration}s)`);
  const boundaries = [0, ...points, duration];
  const pieces = boundaries.slice(0, -1).map((startSeconds, index) => ({
    startSeconds,
    endSeconds: boundaries[index + 1]!,
  }));
  if (pieces.some((piece) => piece.endSeconds - piece.startSeconds < MINIMUM_CUT_PIECE_SECONDS)) {
    throw new Error(`Keep at least ${MINIMUM_CUT_PIECE_SECONDS}s in every piece`);
  }
  return pieces;
}

export function durationCutPoints(durationsSeconds: readonly number[]): number[] {
  return durationsSeconds.reduce<number[]>((points, length) => {
    if (!(length > 0)) throw new Error("Every chunk duration must be positive");
    return [...points, rounded((points.at(-1) ?? 0) + length)];
  }, []);
}

export function formatRangeSeconds(range: VideoRange): string {
  return `${rounded(range.startSeconds)}s-${rounded(range.endSeconds)}s`;
}
