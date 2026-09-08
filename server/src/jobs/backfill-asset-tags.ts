/**
 * Tagging a library that already exists.
 *
 * The pass walks the catalog in bounded pages and runs the same coordinator
 * new assets use, so a backfilled tag and a freshly tagged one are produced by
 * one code path and carry the same fence and provenance.
 *
 * Everything here is shaped by the pass being interruptible. It checks the
 * persisted status between pages, so pause and cancel land within one page
 * rather than at the end of a library; it writes its cursor and counts after
 * every page, so a restart resumes instead of re-running; and it holds no
 * in-memory state that a crash would lose. Adopting cached analysis costs
 * nothing, so the default pass reads caches only and reports how many assets
 * would still need inference — the spend is a separate, explicit choice.
 */

import type { Engine } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { logger } from "../logger.js";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";
import {
  readBackfillState,
  recordOutcome,
  writeBackfillState,
  EMPTY_COUNTS,
  type BackfillState,
} from "../tag-backfill-state.js";
import { runAssetTagging } from "./tag-asset.js";

type BackfillAssetTagsPayload = {
  type: "backfill_asset_tags";
  bookId: string;
  runId?: string | null;
  /** Allow the pass to request analysis for assets with no usable cache. */
  allowAnalysis?: boolean;
  /** Re-tag assets whose snapshot already covers their current content. */
  force?: boolean;
};

/** Assets per page. Small enough that pause lands promptly, large enough that
 *  a big library is not dominated by state writes. */
const PAGE_SIZE = 25;

/** Assets tagged at once within a page. Tagging is mostly file reads; the
 *  provider work it may schedule is bounded by the queue runner, not here. */
const PAGE_CONCURRENCY = 4;

async function mapWithLimit<T, R>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<R>,
  canRun: () => boolean,
): Promise<R[]> {
  const results: R[] = [];
  let next = 0;
  async function worker(): Promise<void> {
    while (canRun()) {
      const index = next;
      next += 1;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await run(item);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, () => worker()),
  );
  return results;
}

/**
 * Ids after the cursor, in catalog order. The cursor is an artifact id rather
 * than an offset because the catalog changes while the pass runs: deleting one
 * asset behind an offset shifts every later page, silently skipping rows.
 */
function pageAfter(engine: Engine, cursor: string | null): string[] {
  const ids = engine.artifacts
    .list({ sort: "oldest" })
    .map((artifact) => artifact.artifactId);
  const start = cursor ? ids.findIndex((id) => id > cursor) : 0;
  if (start < 0) return [];
  return ids.slice(start, start + PAGE_SIZE);
}

function totalArtifacts(engine: Engine): number {
  return engine.artifacts.list().length;
}

export async function runAssetTagBackfill(
  engine: Engine,
  payload: BackfillAssetTagsPayload,
  context?: Pick<JobHandlerContext, "signal">,
): Promise<BackfillState> {
  let state = readBackfillState(engine);
  const runId = payload.runId ?? null;
  if (state.status !== "running" || state.runId !== runId) {
    return state;
  }
  const canRun = () => {
    const latest = readBackfillState(engine);
    return latest.runId === runId && latest.status === "running" && !context?.signal.aborted;
  };

  for (;;) {
    state = readBackfillState(engine);
    if (state.runId !== runId || state.status !== "running") return state;
    if (context?.signal.aborted) {
      return writeBackfillState(engine, { ...state, status: "paused" });
    }
    const page = pageAfter(engine, state.cursor);
    if (page.length === 0) {
      return writeBackfillState(engine, {
        ...state,
        status: "completed",
        finishedAt: Date.now(),
      });
    }

    const outcomes = await mapWithLimit(page, PAGE_CONCURRENCY, async (assetId) => {
      try {
        const result = await runAssetTagging(engine, {
          type: "tag_asset",
          bookId: payload.bookId,
          assetId,
          ...(state.force ? { force: true } : {}),
          ...(state.allowAnalysis ? {} : { cacheOnly: true }),
        }, { canRequestAnalysis: canRun });
        return result.outcome;
      } catch (cause) {
        logger.warn("tag-asset-failed", { assetId, error: cause });
        return "failed";
      }
    }, canRun);

    const latest = readBackfillState(engine);
    if (latest.runId !== runId) return latest;
    let counts = latest.counts;
    for (const outcome of outcomes) counts = recordOutcome(counts, outcome);
    state = writeBackfillState(engine, {
      ...latest,
      cursor: page[outcomes.length - 1] ?? latest.cursor,
      scanned: latest.scanned + outcomes.length,
      counts,
    });
    if (state.status !== "running") return state;
  }
}

/** Starting state for a fresh pass; resume keeps the cursor and counts. */
export function startedState(
  previous: BackfillState,
  options: { allowAnalysis: boolean; force: boolean; resume: boolean },
): BackfillState {
  const resuming = options.resume && previous.status === "paused";
  return {
    runId: uuidv7(),
    status: "running",
    cursor: resuming ? previous.cursor : null,
    scanned: resuming ? previous.scanned : 0,
    counts: resuming ? previous.counts : EMPTY_COUNTS,
    allowAnalysis: options.allowAnalysis,
    force: options.force,
    startedAt: resuming ? previous.startedAt ?? Date.now() : Date.now(),
    updatedAt: Date.now(),
    finishedAt: null,
    lastError: null,
  };
}

export function backfillProgress(
  engine: Engine,
  state: BackfillState,
): { state: BackfillState; total: number; remaining: number } {
  const total = totalArtifacts(engine);
  return {
    state,
    total,
    remaining: Math.max(0, total - state.scanned),
  };
}

export function registerBackfillAssetTagsJob(engine: Engine): void {
  registerJobHandler("backfill_asset_tags", async (payload, ctx) =>
    await runAssetTagBackfill(
      engine,
      payload as BackfillAssetTagsPayload,
      ctx,
    ));
}
