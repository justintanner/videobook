/**
 * Durable state for tagging a library that already exists.
 *
 * A backfill is long, interruptible work over a catalog that changes while it
 * runs: assets get created, deleted and re-cut mid-pass. Two decisions follow
 * from that.
 *
 * The cursor is the last artifact id visited, not an offset. Offsets over a
 * changing catalog silently skip and repeat rows — delete one asset behind the
 * cursor and every later page shifts under it — while an id cursor resumes at
 * exactly the right place whatever happened meanwhile.
 *
 * State lives in the book's own settings, so a restart mid-pass resumes rather
 * than starting over, and a book that is never opened again carries no
 * orphaned progress anywhere else.
 */

import type { Engine } from "videobook-engine";

const SETTINGS_KEY = "asset-tag-backfill";

export type BackfillStatus = "idle" | "running" | "paused" | "cancelled" | "completed";

export type BackfillCounts = {
  /** Assets whose snapshot already covers their current content. */
  current: number;
  /** Assets that gained tags in this pass. */
  tagged: number;
  /** Analyzed, but nothing survived the relevance policy. */
  empty: number;
  /** Needs inference that has not run: no cache, or a cache we cannot use. */
  needsAnalysis: number;
  /** Kinds automatic tagging cannot read at all. */
  unsupported: number;
  /** The asset or its content vanished while the pass was running. */
  skipped: number;
  /** The tag write itself failed. */
  failed: number;
};

export type BackfillState = {
  status: BackfillStatus;
  /** Last artifact id visited; resume continues after it. */
  cursor: string | null;
  /** Artifacts seen so far, for progress against the catalog total. */
  scanned: number;
  counts: BackfillCounts;
  /** Whether this pass may schedule fresh provider analysis. */
  allowAnalysis: boolean;
  /** Whether this pass re-tags assets whose snapshot is already current. */
  force: boolean;
  startedAt: number | null;
  updatedAt: number | null;
  finishedAt: number | null;
  lastError: string | null;
};

export const EMPTY_COUNTS: BackfillCounts = {
  current: 0,
  tagged: 0,
  empty: 0,
  needsAnalysis: 0,
  unsupported: 0,
  skipped: 0,
  failed: 0,
};

export const IDLE_STATE: BackfillState = {
  status: "idle",
  cursor: null,
  scanned: 0,
  counts: EMPTY_COUNTS,
  allowAnalysis: false,
  force: false,
  startedAt: null,
  updatedAt: null,
  finishedAt: null,
  lastError: null,
};

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : 0;
}

function counts(value: unknown): BackfillCounts {
  const row = (typeof value === "object" && value !== null ? value : {}) as
    Record<string, unknown>;
  return {
    current: count(row.current),
    tagged: count(row.tagged),
    empty: count(row.empty),
    needsAnalysis: count(row.needsAnalysis),
    unsupported: count(row.unsupported),
    skipped: count(row.skipped),
    failed: count(row.failed),
  };
}

function status(value: unknown): BackfillStatus {
  return value === "running" || value === "paused" || value === "cancelled"
    || value === "completed"
    ? value
    : "idle";
}

function timestamp(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readBackfillState(engine: Engine): BackfillState {
  const stored = engine.settings.get<Record<string, unknown>>(SETTINGS_KEY);
  if (!stored) return { ...IDLE_STATE };
  return {
    status: status(stored.status),
    cursor: typeof stored.cursor === "string" ? stored.cursor : null,
    scanned: count(stored.scanned),
    counts: counts(stored.counts),
    allowAnalysis: stored.allowAnalysis === true,
    force: stored.force === true,
    startedAt: timestamp(stored.startedAt),
    updatedAt: timestamp(stored.updatedAt),
    finishedAt: timestamp(stored.finishedAt),
    lastError: typeof stored.lastError === "string" ? stored.lastError : null,
  };
}

export function writeBackfillState(
  engine: Engine,
  state: BackfillState,
): BackfillState {
  const next = { ...state, updatedAt: Date.now() };
  const written = engine.settings.set(SETTINGS_KEY, next);
  if (!written.ok) throw new Error(written.error.message);
  return next;
}

/** Adds one asset's outcome to a running tally. */
export function recordOutcome(
  current: BackfillCounts,
  outcome: string,
): BackfillCounts {
  const next = { ...current };
  switch (outcome) {
    case "tagged":
      next.tagged += 1;
      break;
    case "already_current":
      next.current += 1;
      break;
    case "no_useful_evidence":
      next.empty += 1;
      break;
    case "no_evidence":
    case "analysis_requested":
    case "analysis_unavailable":
      next.needsAnalysis += 1;
      break;
    case "unsupported_kind":
      next.unsupported += 1;
      break;
    case "missing_asset":
    case "no_source_content":
      next.skipped += 1;
      break;
    default:
      next.failed += 1;
      break;
  }
  return next;
}
