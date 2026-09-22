export interface BeatScore {
  precision: number;
  recall: number;
  f1: number;
  medianAbsErrorSeconds: number | null;
  hits: number;
  referenceCount: number;
  detectedCount: number;
}

export function scoreBeats(
  referenceSeconds: readonly number[],
  detectedSeconds: readonly number[],
  toleranceSeconds: number,
): BeatScore {
  const used = new Set<number>();
  const errors: number[] = [];
  for (const reference of referenceSeconds) {
    let best = -1;
    let bestDistance = Number.POSITIVE_INFINITY;
    detectedSeconds.forEach((detected, index) => {
      if (used.has(index)) return;
      const distance = Math.abs(detected - reference);
      if (distance <= toleranceSeconds && distance < bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    if (best >= 0) {
      used.add(best);
      errors.push(bestDistance);
    }
  }
  const hits = errors.length;
  const precision = detectedSeconds.length === 0
    ? (referenceSeconds.length === 0 ? 1 : 0)
    : hits / detectedSeconds.length;
  const recall = referenceSeconds.length === 0
    ? (detectedSeconds.length === 0 ? 1 : 0)
    : hits / referenceSeconds.length;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return {
    precision,
    recall,
    f1,
    medianAbsErrorSeconds: median(errors),
    hits,
    referenceCount: referenceSeconds.length,
    detectedCount: detectedSeconds.length,
  };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : sorted[middle] ?? 0;
}
