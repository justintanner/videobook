export interface AnalysisShotInput {
  startSeconds: number;
  endSeconds: number;
  label?: string;
  prompt?: string;
}

export interface NormalizedShot {
  ordinal: number;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  label: string;
  prompt?: string;
}

export interface ShotRange {
  startSeconds: number;
  endSeconds: number;
}

export const MAX_SHOT_SECONDS = 15;

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export function normalizeShots(
  shots: AnalysisShotInput[],
  sourceDurationSeconds: number,
): NormalizedShot[] {
  if (!(sourceDurationSeconds > 0)) {
    throw new Error("Source duration must be positive");
  }
  const duration = roundTime(sourceDurationSeconds);
  const cleaned = shots
    .map((shot) => ({
      startSeconds: Math.max(0, Math.min(duration, shot.startSeconds)),
      endSeconds: Math.max(0, Math.min(duration, shot.endSeconds)),
      label: shot.label?.trim() || undefined,
      prompt: shot.prompt?.trim() || undefined,
    }))
    .filter((shot) => shot.endSeconds > shot.startSeconds)
    .sort((left, right) => left.startSeconds - right.startSeconds);

  type PreparedRange = ShotRange & {
    label?: string;
    prompt?: string;
  };
  const raw: PreparedRange[] = cleaned.length > 0
    ? cleaned
    : [{ startSeconds: 0, endSeconds: duration }];
  const covered: PreparedRange[] = [];
  let cursor = 0;
  for (const shot of raw) {
    let start = Math.max(cursor, shot.startSeconds);
    let end = Math.max(start, shot.endSeconds);
    if (start > cursor) {
      covered.push({ startSeconds: cursor, endSeconds: start });
    }
    if (covered.length > 0) {
      const previous = covered[covered.length - 1]!;
      if (start < previous.endSeconds) start = previous.endSeconds;
      if (end < start) end = start;
    }
    if (end > start) {
      covered.push({
        startSeconds: start,
        endSeconds: end,
        ...(shot.label ? { label: shot.label } : {}),
        ...(shot.prompt ? { prompt: shot.prompt } : {}),
      });
      cursor = end;
    }
  }
  if (cursor < duration) {
    covered.push({ startSeconds: cursor, endSeconds: duration });
  }
  if (covered.length === 0) {
    covered.push({ startSeconds: 0, endSeconds: duration });
  }
  covered[0]!.startSeconds = 0;
  covered[covered.length - 1]!.endSeconds = duration;
  for (let index = 1; index < covered.length; index += 1) {
    covered[index]!.startSeconds = covered[index - 1]!.endSeconds;
  }
  const finalRanges: PreparedRange[] = [];
  for (const shot of covered) {
    const rangeDuration = roundTime(shot.endSeconds - shot.startSeconds);
    const partCount = Math.max(
      1,
      Math.ceil(rangeDuration / MAX_SHOT_SECONDS),
    );
    let start = shot.startSeconds;
    for (let part = 0; part < partCount; part += 1) {
      const end = part === partCount - 1
        ? shot.endSeconds
        : roundTime(
            shot.startSeconds + rangeDuration * (part + 1) / partCount,
          );
      finalRanges.push({
        startSeconds: start,
        endSeconds: end,
        ...(shot.label ? { label: shot.label } : {}),
        ...(shot.prompt ? { prompt: shot.prompt } : {}),
      });
      start = end;
    }
  }

  return finalRanges.map((shot, index) => {
    const durationSeconds = roundTime(shot.endSeconds - shot.startSeconds);
    return {
      ordinal: index + 1,
      startSeconds: roundTime(shot.startSeconds),
      endSeconds: roundTime(shot.endSeconds),
      durationSeconds,
      label: shot.label ?? `Shot ${index + 1}`,
      ...(shot.prompt ? { prompt: shot.prompt } : {}),
    };
  });
}

export function overlapSeconds(left: ShotRange, right: ShotRange): number {
  const start = Math.max(left.startSeconds, right.startSeconds);
  const end = Math.min(left.endSeconds, right.endSeconds);
  return Math.max(0, end - start);
}

export interface OwnedBranch {
  cellId: string;
  range: ShotRange;
  config: Record<string, unknown>;
}

export interface BranchReconcileResult {
  keep: Array<{ existing: OwnedBranch; shot: NormalizedShot }>;
  create: NormalizedShot[];
  remove: OwnedBranch[];
}

/**
 * Match existing analysis-owned branches to new shots by greatest tick-range
 * overlap. Unmatched owned branches are removed; unmatched shots are created.
 */
export function reconcileOwnedBranches(
  existing: OwnedBranch[],
  shots: NormalizedShot[],
): BranchReconcileResult {
  const remaining = [...existing];
  const keep: BranchReconcileResult["keep"] = [];
  const create: NormalizedShot[] = [];

  for (const shot of shots) {
    let bestIndex = -1;
    let bestOverlap = 0;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const overlap = overlapSeconds(candidate.range, shot);
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestIndex = index;
      }
    }
    if (bestIndex >= 0 && bestOverlap > 0) {
      const [matched] = remaining.splice(bestIndex, 1);
      keep.push({ existing: matched!, shot });
    } else {
      create.push(shot);
    }
  }

  return {
    keep,
    create,
    remove: remaining,
  };
}

export function parseAnalysisShots(raw: unknown): AnalysisShotInput[] {
  if (!raw || typeof raw !== "object") return [];
  const record = raw as Record<string, unknown>;
  const candidates = Array.isArray(record.shots)
    ? record.shots
    : Array.isArray(record.scenes)
      ? record.scenes
      : [];
  const shots: AnalysisShotInput[] = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      continue;
    }
    const entry = candidate as Record<string, unknown>;
    const start = Number(
      entry.startSeconds
        ?? entry.start
        ?? entry.start_time
        ?? (Array.isArray(entry.timestamp) ? entry.timestamp[0] : undefined),
    );
    const end = Number(
      entry.endSeconds
        ?? entry.end
        ?? entry.end_time
        ?? (Array.isArray(entry.timestamp) ? entry.timestamp[1] : undefined),
    );
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    shots.push({
      startSeconds: start,
      endSeconds: end,
      ...(typeof entry.label === "string" ? { label: entry.label } : {}),
      ...(typeof entry.prompt === "string" ? { prompt: entry.prompt } : {}),
      ...(typeof entry.title === "string" && !entry.label
        ? { label: entry.title }
        : {}),
    });
  }
  return shots;
}
