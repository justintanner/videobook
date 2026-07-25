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

export const MIN_SHOT_SECONDS = 4;
export const MAX_SHOT_SECONDS = 15;

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Normalize provider shot ranges into continuous non-overlapping 4–15s ranges
 * that cover [0, sourceDurationSeconds] exactly.
 */
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

  const raw: ShotRange[] = cleaned.length > 0
    ? cleaned.map((shot) => ({
      startSeconds: shot.startSeconds,
      endSeconds: shot.endSeconds,
    }))
    : [{ startSeconds: 0, endSeconds: duration }];

  // Force continuous coverage without collapsing distinct abutting analysis shots.
  const covered: ShotRange[] = [];
  let cursor = 0;
  for (const shot of raw) {
    let start = Math.max(cursor, shot.startSeconds);
    let end = Math.max(start, shot.endSeconds);
    if (start > cursor) {
      covered.push({ startSeconds: cursor, endSeconds: start });
    }
    // Clip overlap with previous covered range but keep this shot distinct.
    if (covered.length > 0) {
      const previous = covered[covered.length - 1]!;
      if (start < previous.endSeconds) start = previous.endSeconds;
      if (end < start) end = start;
    }
    if (end > start) {
      covered.push({ startSeconds: start, endSeconds: end });
      cursor = end;
    }
  }
  if (cursor < duration) {
    covered.push({ startSeconds: cursor, endSeconds: duration });
  }

  // Split long ranges into generation-safe lengths; keep abutting shots separate.
  const sized: ShotRange[] = [];
  for (const shot of covered) {
    let start = shot.startSeconds;
    while (roundTime(shot.endSeconds - start) > MAX_SHOT_SECONDS) {
      const end = roundTime(start + MAX_SHOT_SECONDS);
      sized.push({ startSeconds: start, endSeconds: end });
      start = end;
    }
    if (shot.endSeconds > start) {
      sized.push({ startSeconds: start, endSeconds: shot.endSeconds });
    }
  }

  // Merge short ranges into neighbors when the combined range stays within max.
  let stable = sized.map((shot) => ({ ...shot }));
  let changed = true;
  while (changed && stable.length > 1) {
    changed = false;
    for (let index = 0; index < stable.length; index += 1) {
      const shot = stable[index]!;
      const durationSeconds = roundTime(shot.endSeconds - shot.startSeconds);
      if (durationSeconds >= MIN_SHOT_SECONDS) continue;
      const previous = stable[index - 1];
      const next = stable[index + 1];
      if (
        previous
        && roundTime(shot.endSeconds - previous.startSeconds) <= MAX_SHOT_SECONDS
      ) {
        previous.endSeconds = shot.endSeconds;
        stable.splice(index, 1);
        changed = true;
        break;
      }
      if (
        next
        && roundTime(next.endSeconds - shot.startSeconds) <= MAX_SHOT_SECONDS
      ) {
        next.startSeconds = shot.startSeconds;
        stable.splice(index, 1);
        changed = true;
        break;
      }
      if (previous) {
        const needed = roundTime(MIN_SHOT_SECONDS - durationSeconds);
        const previousDuration = roundTime(
          previous.endSeconds - previous.startSeconds,
        );
        if (previousDuration - needed >= MIN_SHOT_SECONDS) {
          previous.endSeconds = roundTime(previous.endSeconds - needed);
          shot.startSeconds = previous.endSeconds;
          changed = true;
          break;
        }
      }
      if (next) {
        const needed = roundTime(MIN_SHOT_SECONDS - durationSeconds);
        const nextDuration = roundTime(next.endSeconds - next.startSeconds);
        if (nextDuration - needed >= MIN_SHOT_SECONDS) {
          next.startSeconds = roundTime(next.startSeconds + needed);
          shot.endSeconds = next.startSeconds;
          changed = true;
          break;
        }
      }
    }
  }

  // Ensure exact coverage after rounding.
  if (stable.length === 0) {
    stable = [{ startSeconds: 0, endSeconds: duration }];
  }
  stable[0]!.startSeconds = 0;
  stable[stable.length - 1]!.endSeconds = duration;
  for (let index = 1; index < stable.length; index += 1) {
    stable[index]!.startSeconds = stable[index - 1]!.endSeconds;
  }

  // Final pass: split any remaining over-long ranges after coverage fix.
  const finalRanges: ShotRange[] = [];
  for (const shot of stable) {
    let start = shot.startSeconds;
    while (roundTime(shot.endSeconds - start) > MAX_SHOT_SECONDS) {
      const end = roundTime(start + MAX_SHOT_SECONDS);
      finalRanges.push({ startSeconds: start, endSeconds: end });
      start = end;
    }
    if (shot.endSeconds > start) {
      finalRanges.push({ startSeconds: start, endSeconds: shot.endSeconds });
    }
  }

  return finalRanges.map((shot, index) => {
    const source = cleaned[Math.min(index, Math.max(0, cleaned.length - 1))];
    const durationSeconds = roundTime(shot.endSeconds - shot.startSeconds);
    return {
      ordinal: index + 1,
      startSeconds: roundTime(shot.startSeconds),
      endSeconds: roundTime(shot.endSeconds),
      durationSeconds,
      label: source?.label ?? `Shot ${index + 1}`,
      ...(source?.prompt ? { prompt: source.prompt } : {}),
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
