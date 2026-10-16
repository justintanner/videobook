import { join } from "node:path";
import { findVideoFile, type Engine } from "videobook-engine";
import { z } from "zod";
import { getApiKey } from "../api-key.js";
import { isSubtitleStyle } from "../remotion/subtitles/styles.js";
import type { AnalyzeKeywordPlacementResult } from "../jobs/analyze-keyword-placement.js";
import {
  isKeywordPlacementCacheValid,
  keywordPlacementFingerprint,
  parseKeywordPlacementAnalysis,
  readKeywordPlacementAnalysis,
} from "../keyword-placement-cache.js";
import { queue } from "../queue.js";
import { artifactKindOf } from "./_shared.js";
import {
  DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
  DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT,
  parseKeywordTranscript,
  selectKeywordGraphics,
  selectRequestedKeywordGraphics,
} from "../remotion/keyword-graphics.js";
import {
  KEYWORD_FRAME_CACHE_FILENAME,
  resolveKeywordPlacements,
} from "../remotion/keyword-placement.js";
import type {
  KeywordPlacementAnalysis,
  KeywordPlacementSettings,
} from "../remotion/keyword-placement.js";
import type {
  FontSizePreset,
  KeywordGraphic,
  Orientation,
  SubtitlePosition,
} from "../remotion/subtitles/types.js";
import type { ToolDef } from "./tool-def.js";
import { RENDER_ORIENTATIONS } from "./reconcile-project-work.js";

async function persistSettings(
  engine: Engine,
  assetId: string,
  enabled: boolean,
  maxCount: number,
  lingerSeconds: number,
  keywords: string[] | null,
): Promise<void> {
  for (const orientation of RENDER_ORIENTATIONS) {
    const existing = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orientation}.render`
    );
    const write = await engine.metadata.artifacts.write(assetId, `${orientation}.render`, {
      ...(existing.ok ? existing.value : {}),
      keywordGraphicsEnabled: enabled,
      keywordGraphicsMaxCount: maxCount,
      keywordGraphicsLingerSeconds: lingerSeconds,
      keywordGraphicsKeywords: keywords,
    });
    if (!write.ok) throw new Error(`Failed to persist ${orientation} keyword settings: ${write.error.message}`);
  }
}

function isSubtitlePosition(value: unknown): value is SubtitlePosition {
  return value === "top" || value === "middle" || value === "bottom";
}

function isFontSize(value: unknown): value is FontSizePreset {
  return value === "small" || value === "medium" || value === "large";
}

async function placementSummary(
  engine: Engine,
  assetId: string,
  graphics: KeywordGraphic[],
  analysis: KeywordPlacementAnalysis,
): Promise<Record<Orientation, Record<string, unknown>>> {
  const summaries = {} as Record<Orientation, Record<string, unknown>>;
  for (const orientation of RENDER_ORIENTATIONS) {
    const storedResult = await engine.metadata.artifacts.read<Record<string, unknown>>(assetId, `${orientation}.render`
    );
    const stored = storedResult.ok ? storedResult.value : {};
    const settings: KeywordPlacementSettings = {
      subtitlesEnabled: stored.subtitlesEnabled === true,
      subtitlePosition: isSubtitlePosition(stored.position) ? stored.position : "bottom",
      subtitleStyle: isSubtitleStyle(stored.highlightStyle) ? stored.highlightStyle : "impact",
      subtitleFontSize: isFontSize(stored.fontSize) ? stored.fontSize : "medium",
    };
    const resolved = resolveKeywordPlacements(graphics, analysis, orientation, settings);
    summaries[orientation] = {
      keywords: resolved.graphics.map((graphic) => ({
        text: graphic.text,
        anchor: graphic.anchor,
        scale: graphic.scale,
        frame_time: graphic.frameTime,
      })),
      skipped: resolved.skipped,
    };
  }
  return summaries;
}

function errorResult(status: string, message: string, details: Record<string, unknown> = {}) {
  return {
    isError: true as const,
    content: [{ type: "text" as const, text: JSON.stringify({ status, message, ...details }) }],
  };
}

export function animateKeywordsDef(engine: Engine): ToolDef {
  return {
    name: "animate_keywords",
    description:
      "Turn transcript-timed keyword titles on or off for a video's renders, placed by vision away from faces, subtitles and on-screen text. Pass keywords for exact transcript words, or omit them for automatic picks.",
    schema: {
      asset_id: z.string().describe("Video artifact id"),
      book_id: z.string().describe("Book id"),
      enabled: z.boolean().optional().describe("Enable keyword graphics (default true)"),
      max_keywords: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum keyword graphics selected from the transcript (default 8)"),
      linger_seconds: z
        .number()
        .min(0.8)
        .max(5)
        .optional()
        .describe("How long each keyword lingers after it is spoken (default 2.4 seconds)"),
      keywords: z
        .array(z.string().min(1))
        .min(1)
        .max(20)
        .optional()
        .describe("Exact transcript words to animate, matched case-insensitively"),
    },
    handler: async (args) => {
      const {
        asset_id,
        book_id,
        enabled = true,
        max_keywords = DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT,
        linger_seconds = DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
        keywords,
      } = args as {
        asset_id: string;
        book_id: string;
        enabled?: boolean;
        max_keywords?: number;
        linger_seconds?: number;
        keywords?: string[];
      };

      // Kept on the structured errorResult contract instead of
      // requireArtifactKind so callers keep parsing a status code. A missing
      // artifact falls through to the manifest read below, which reports
      // asset_not_found.
      const kind = artifactKindOf(engine, asset_id);
      if (kind !== null && kind !== "video") {
        return errorResult("invalid_asset", `animate_keywords requires a video artifact; ${asset_id} is ${kind}`);
      }

      const manifestResult = await engine.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return errorResult("asset_not_found", manifestResult.error.message);
      }

      if (!enabled) {
        try {
          await persistSettings(engine, asset_id, false, max_keywords, linger_seconds, null);
        } catch (error) {
          return errorResult("settings_write_failed", error instanceof Error ? error.message : String(error));
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ asset_id, status: "configured", enabled: false }),
          }],
        };
      }

      const transcriptResult = await engine.files.read(asset_id, "elevenlabs.json");
      if (!transcriptResult.ok) {
        return errorResult(
          "missing_transcript",
          `No timed transcript found for ${asset_id}. Run /transcribe @${asset_id} first.`,
        );
      }

      let raw: unknown;
      try {
        raw = JSON.parse(transcriptResult.value.toString()) as unknown;
      } catch {
        return errorResult("invalid_transcript", `The timed transcript for ${asset_id} is not valid JSON.`);
      }

      const segments = parseKeywordTranscript(raw);
      const requested = keywords?.length
        ? selectRequestedKeywordGraphics(segments, keywords, { lingerSeconds: linger_seconds })
        : null;
      if (requested && requested.missing.length > 0) {
        return errorResult(
          "keywords_not_found",
          `Some requested keywords were not found in the timed transcript for ${asset_id}.`,
          { missing_keywords: requested.missing },
        );
      }
      const graphics = requested?.graphics ?? selectKeywordGraphics(segments, {
        maxCount: max_keywords,
        lingerSeconds: linger_seconds,
      });
      if (graphics.length === 0) {
        return errorResult(
          "no_timed_words",
          `The transcript for ${asset_id} has no usable word-level timing. Run /transcribe @${asset_id} again.`,
        );
      }

      const videoFile = findVideoFile(manifestResult.value.files);
      if (!videoFile) {
        return errorResult("missing_video", `No video file found in ${asset_id}.`);
      }

      const fingerprint = keywordPlacementFingerprint(videoFile, transcriptResult.value, graphics);
      let analysis = await readKeywordPlacementAnalysis(engine, asset_id);
      let cached = await isKeywordPlacementCacheValid(
        engine,
        asset_id,
        analysis,
        fingerprint,
        graphics,
      );
      let jobId: string | null = null;
      if (!cached) {
        if (!getApiKey("OPENAI_API_KEY")) {
          return errorResult(
            "missing_vision_provider",
            "OPENAI_API_KEY is required to verify face-safe keyword placement.",
          );
        }
        const clear = await engine.jobs.failures.clear(asset_id);
        if (!clear.ok) {
          return errorResult("placement_analysis_failed", clear.error.message);
        }
        jobId = `keyword-placement-${asset_id}-${Date.now()}`;
        try {
          const result = await queue.enqueueAndWait<AnalyzeKeywordPlacementResult>(jobId, {
            type: "analyze_keyword_placement",
            assetId: asset_id,
            assetDir: manifestResult.value.path,
            bookId: book_id,
            videoPath: join(manifestResult.value.path, videoFile.name),
            fingerprint,
            graphics,
          }, 300_000);
          analysis = parseKeywordPlacementAnalysis(result.analysis);
          cached = false;
        } catch (error) {
          return errorResult(
            "placement_analysis_failed",
            error instanceof Error ? error.message : String(error),
          );
        }
      }
      if (!analysis) {
        return errorResult("placement_analysis_failed", "Keyword placement analysis was not persisted.");
      }

      let placements: Record<Orientation, Record<string, unknown>>;
      try {
        placements = await placementSummary(engine, asset_id, graphics, analysis);
      } catch (error) {
        return errorResult(
          "placement_analysis_failed",
          error instanceof Error ? error.message : String(error),
        );
      }

      const resolvedKeywords = requested ? graphics.map((graphic) => graphic.text) : null;
      try {
        await persistSettings(
          engine,
          asset_id,
          true,
          max_keywords,
          linger_seconds,
          resolvedKeywords,
        );
      } catch (error) {
        return errorResult("settings_write_failed", error instanceof Error ? error.message : String(error));
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id,
            status: "configured",
            enabled: true,
            style: "cinematic-serif",
            placement_status: "completed",
            cached,
            frame_cache: KEYWORD_FRAME_CACHE_FILENAME,
            job_id: jobId,
            mode: requested ? "explicit" : "automatic",
            max_keywords,
            linger_seconds,
            requested_keywords: resolvedKeywords,
            keywords: graphics,
            placements,
          }),
        }],
      };
    },
  };
}
