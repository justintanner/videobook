import { join } from "node:path";
import { findVideoFile, type VideocityFs } from "videocity-engine";
import { z } from "zod";
import { getApiKey } from "../api-key.js";
import type { AnalyzeKeywordPlacementResult } from "../jobs/analyze-keyword-placement.js";
import {
  isKeywordPlacementCacheValid,
  keywordPlacementFingerprint,
  parseKeywordPlacementAnalysis,
  readKeywordPlacementAnalysis,
} from "../keyword-placement-cache.js";
import { queue } from "../queue.js";
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
  SubtitleStyle,
} from "../remotion/subtitles/types.js";
import type { ToolDef } from "./tool-def.js";
import { RENDER_ORIENTATIONS } from "./sync.js";

async function persistSettings(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
  enabled: boolean,
  maxCount: number,
  lingerSeconds: number,
  keywords: string[] | null,
): Promise<void> {
  for (const orientation of RENDER_ORIENTATIONS) {
    const existing = await fs.readMetadata<Record<string, unknown>>(
      assetId,
      `${orientation}.render`,
      projectSlug,
    );
    const write = await fs.writeMetadata(assetId, `${orientation}.render`, {
      ...(existing.ok ? existing.value : {}),
      keywordGraphicsEnabled: enabled,
      keywordGraphicsMaxCount: maxCount,
      keywordGraphicsLingerSeconds: lingerSeconds,
      keywordGraphicsKeywords: keywords,
    }, projectSlug);
    if (!write.ok) throw new Error(`Failed to persist ${orientation} keyword settings: ${write.error.message}`);
  }
}

function isSubtitlePosition(value: unknown): value is SubtitlePosition {
  return value === "top" || value === "middle" || value === "bottom";
}

function isSubtitleStyle(value: unknown): value is SubtitleStyle {
  return value === "impact" || value === "highlight";
}

function isFontSize(value: unknown): value is FontSizePreset {
  return value === "small" || value === "medium" || value === "large";
}

async function placementSummary(
  fs: VideocityFs,
  assetId: string,
  projectSlug: string,
  graphics: KeywordGraphic[],
  analysis: KeywordPlacementAnalysis,
): Promise<Record<Orientation, Record<string, unknown>>> {
  const summaries = {} as Record<Orientation, Record<string, unknown>>;
  for (const orientation of RENDER_ORIENTATIONS) {
    const storedResult = await fs.readMetadata<Record<string, unknown>>(
      assetId,
      `${orientation}.render`,
      projectSlug,
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

export function animateKeywordsDef(fs: VideocityFs): ToolDef {
  return {
    name: "animate_keywords",
    description:
      "Configure transcript-timed keyword graphics for a video. Extracts exact word-time frames and waits for vision-guided placement that avoids faces, subtitles, and existing text or graphics. Pass keywords for exact transcript words, or omit them for automatic selection. Renders cinematic white serif over-the-shoulder titles. Use enabled=false to turn them off.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid- prefix)"),
      project_slug: z.string().describe("Project slug"),
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
        project_slug,
        enabled = true,
        max_keywords = DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT,
        linger_seconds = DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
        keywords,
      } = args as {
        asset_id: string;
        project_slug: string;
        enabled?: boolean;
        max_keywords?: number;
        linger_seconds?: number;
        keywords?: string[];
      };

      if (!asset_id.startsWith("vid-")) {
        return errorResult("invalid_asset", "asset_id must start with vid-");
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug, { includeDotfiles: true });
      if (!manifestResult.ok) {
        return errorResult("asset_not_found", manifestResult.error.message);
      }

      if (!enabled) {
        try {
          await persistSettings(fs, asset_id, project_slug, false, max_keywords, linger_seconds, null);
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

      const transcriptResult = await fs.readFile(asset_id, "elevenlabs.json", project_slug);
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
      let analysis = await readKeywordPlacementAnalysis(fs, asset_id, project_slug);
      let cached = await isKeywordPlacementCacheValid(
        fs,
        asset_id,
        project_slug,
        analysis,
        fingerprint,
        graphics,
      );
      let jobId: string | null = null;
      if (!cached) {
        if (!getApiKey("KIE_API_KEY")) {
          return errorResult(
            "missing_vision_provider",
            "KIE_API_KEY is required to verify face-safe keyword placement.",
          );
        }
        const clear = await fs.generationErrors.clear(project_slug, asset_id);
        if (!clear.ok) {
          return errorResult("placement_analysis_failed", clear.error.message);
        }
        jobId = `keyword-placement-${asset_id}-${Date.now()}`;
        try {
          const result = await queue.enqueueAndWait<AnalyzeKeywordPlacementResult>(jobId, {
            type: "analyze_keyword_placement",
            assetId: asset_id,
            assetDir: manifestResult.value.path,
            projectSlug: project_slug,
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
        placements = await placementSummary(fs, asset_id, project_slug, graphics, analysis);
      } catch (error) {
        return errorResult(
          "placement_analysis_failed",
          error instanceof Error ? error.message : String(error),
        );
      }

      const resolvedKeywords = requested ? graphics.map((graphic) => graphic.text) : null;
      try {
        await persistSettings(
          fs,
          asset_id,
          project_slug,
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
