export type SpliceMatchScores = {
  fps: number;
  firstDuration: number;
  windowStartFrame: number;
  scores: readonly number[];
};

export type SpliceCut = {
  frameIndex: number | null;
  timestamp: number;
  score: number | null;
};

export function spliceSearchStartFrame(
  firstDuration: number,
  fps: number,
  overlap: number,
): number {
  const window = Math.max(overlap, 1 / fps);
  return Math.floor(Math.max(0, firstDuration - window) * fps);
}

export function lowestScoreIndex(scores: readonly number[], from = 0): number {
  let bestIndex = -1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let index = Math.max(0, from); index < scores.length; index += 1) {
    const score = scores[index]!;
    if (score < bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  }
  return bestIndex;
}

export function spliceCutForOverlap(
  match: SpliceMatchScores,
  overlap: number,
): SpliceCut | null {
  if (!Number.isFinite(overlap) || overlap < 0) return null;
  if (overlap === 0) {
    return { frameIndex: null, timestamp: match.firstDuration, score: null };
  }
  const startFrame = spliceSearchStartFrame(match.firstDuration, match.fps, overlap);
  const offset = Math.max(0, startFrame - match.windowStartFrame);
  const index = lowestScoreIndex(match.scores, offset);
  if (index < 0) return null;
  const frameIndex = match.windowStartFrame + index;
  return {
    frameIndex,
    timestamp: frameIndex / match.fps,
    score: match.scores[index]!,
  };
}
