/**
 * Controls for tagging a library that already exists, and for how new assets
 * are tagged from here on.
 *
 * The split these tools express: adopting cached analysis is free and happens
 * by default, while asking a provider to analyze media that was never
 * analyzed costs money and happens only when someone says so. A caller can
 * therefore run a full pass, read the counts, and then decide whether the
 * remaining assets are worth paying for.
 */

import type { Engine } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { queue } from "../queue.js";
import {
  backfillProgress,
  startedState,
} from "../jobs/backfill-asset-tags.js";
import { runAssetTagging } from "../jobs/tag-asset.js";
import {
  readBackfillState,
  writeBackfillState,
  type BackfillState,
} from "../tag-backfill-state.js";
import {
  readTaggingSettings,
  writeTaggingSettings,
} from "../tag-settings.js";
import { assetTagSummary } from "../asset-tags.js";
import { TAG_ANALYZER_VERSION } from "../tag-vocabulary.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(cause: unknown): ToolResult {
  return {
    isError: true,
    content: [{
      type: "text",
      text: cause instanceof Error ? cause.message : String(cause),
    }],
  };
}

function progressPayload(engine: Engine, state: BackfillState) {
  const progress = backfillProgress(engine, state);
  return {
    status: progress.state.status,
    analyzer_version: TAG_ANALYZER_VERSION,
    allow_analysis: progress.state.allowAnalysis,
    force: progress.state.force,
    scanned: progress.state.scanned,
    total: progress.total,
    remaining: progress.remaining,
    counts: {
      tagged: progress.state.counts.tagged,
      already_current: progress.state.counts.current,
      no_useful_evidence: progress.state.counts.empty,
      needs_analysis: progress.state.counts.needsAnalysis,
      unsupported: progress.state.counts.unsupported,
      skipped: progress.state.counts.skipped,
      failed: progress.state.counts.failed,
    },
    started_at: progress.state.startedAt,
    updated_at: progress.state.updatedAt,
    finished_at: progress.state.finishedAt,
    ...(progress.state.lastError ? { last_error: progress.state.lastError } : {}),
  };
}

export function tagBackfillDefs(engine: Engine): ToolDef[] {
  return [
    {
      name: "backfill_asset_tags",
      description:
        "Tag the assets already in a book. 'start' adopts tags from analysis the book has already paid for; pass allow_analysis to also analyze assets that were never analyzed, which costs provider calls. Pause, resume, cancel and status report the same bounded, resumable pass.",
      schema: {
        book_id: z.string().describe("Book to backfill"),
        action: z.enum(["start", "resume", "pause", "cancel", "status"])
          .describe("What to do with this book's backfill pass"),
        allow_analysis: z.boolean().optional().describe(
          "Analyze assets with no usable cached analysis; this spends provider calls",
        ),
        force: z.boolean().optional().describe(
          "Re-tag assets whose tags already cover their current content",
        ),
      },
      handler: async (args) => {
        const { book_id, action, allow_analysis, force } = args as {
          book_id: string;
          action: "start" | "resume" | "pause" | "cancel" | "status";
          allow_analysis?: boolean;
          force?: boolean;
        };
        try {
          const previous = readBackfillState(engine);
          if (action === "status") return json(progressPayload(engine, previous));
          if (action === "pause" || action === "cancel") {
            if (previous.status !== "running") {
              return json(progressPayload(engine, previous));
            }
            // The running pass reads this between pages and stops there.
            const stopped = writeBackfillState(engine, {
              ...previous,
              status: action === "pause" ? "paused" : "cancelled",
              ...(action === "cancel" ? { finishedAt: Date.now() } : {}),
            });
            return json(progressPayload(engine, stopped));
          }
          if (previous.status === "running") {
            return json(progressPayload(engine, previous));
          }
          const started = writeBackfillState(engine, startedState(previous, {
            allowAnalysis: allow_analysis === true,
            force: force === true,
            resume: action === "resume",
          }));
          await queue.enqueue(`backfill-asset-tags-${book_id}-${uuidv7()}`, {
            type: "backfill_asset_tags",
            bookId: book_id,
            ...(allow_analysis ? { allowAnalysis: true } : {}),
            ...(force ? { force: true } : {}),
          } as unknown as Record<string, unknown>);
          return json(progressPayload(engine, started));
        } catch (cause) {
          return failure(cause);
        }
      },
    },
    {
      name: "retag_asset",
      description:
        "Re-run tagging for one asset and return its tag state. Manual tags and dismissals are preserved; use it to retry after adding a provider key or to pick up a newer analysis.",
      schema: {
        book_id: z.string().describe("Book that owns the asset"),
        asset_id: z.string().describe("Artifact id to re-tag"),
        force: z.boolean().optional().describe(
          "Re-run even when the current tags already cover this content",
        ),
        cached_only: z.boolean().optional().describe(
          "Adopt cached analysis only; never request new provider analysis",
        ),
      },
      handler: async (args) => {
        const { book_id, asset_id, force, cached_only } = args as {
          book_id: string;
          asset_id: string;
          force?: boolean;
          cached_only?: boolean;
        };
        try {
          const result = await runAssetTagging(engine, {
            type: "tag_asset",
            bookId: book_id,
            assetId: asset_id,
            ...(force ? { force: true } : {}),
            ...(cached_only ? { cacheOnly: true } : {}),
          });
          if (result.outcome === "missing_asset") {
            return failure(new Error(`Asset not found: ${asset_id}`));
          }
          const state = engine.tags.read(asset_id);
          return json({
            asset_id,
            outcome: result.outcome,
            tag_count: result.tagCount,
            analyzer_version: result.analyzerVersion,
            ...(state.ok ? { tags: assetTagSummary(state.value) } : {}),
          });
        } catch (cause) {
          return failure(cause);
        }
      },
    },
    {
      name: "configure_asset_tagging",
      description:
        "Read or change how new assets are tagged in a book. Manual tagging, filtering and search keep working whatever this is set to.",
      schema: {
        book_id: z.string().describe("Book to configure"),
        automatic_enabled: z.boolean().optional().describe(
          "Tag new assets automatically as they become ready",
        ),
        analysis_on_new_assets: z.boolean().optional().describe(
          "Let automatic tagging analyze new assets that have no cached analysis",
        ),
      },
      handler: async (args) => {
        const { automatic_enabled, analysis_on_new_assets } = args as {
          automatic_enabled?: boolean;
          analysis_on_new_assets?: boolean;
        };
        try {
          const update = {
            ...(automatic_enabled === undefined
              ? {}
              : { automaticEnabled: automatic_enabled }),
            ...(analysis_on_new_assets === undefined
              ? {}
              : { analysisOnNewAssets: analysis_on_new_assets }),
          };
          const settings = Object.keys(update).length > 0
            ? writeTaggingSettings(engine, update)
            : readTaggingSettings(engine);
          return json({
            automatic_enabled: settings.automaticEnabled,
            analysis_on_new_assets: settings.analysisOnNewAssets,
            analyzer_version: TAG_ANALYZER_VERSION,
          });
        } catch (cause) {
          return failure(cause);
        }
      },
    },
  ];
}
