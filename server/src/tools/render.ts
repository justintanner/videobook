import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { logger } from "../logger.js";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import { isValidHex } from "../remotion/util.js";
import type { Orientation, OsgPosition } from "../remotion/subtitles/types.js";
import type { ToolDef } from "./tool-def.js";
import { requireArtifactKind } from "./_shared.js";
import { isOsgPosition, isOsgSize, resolveOsgImagePath } from "../osg-assets.js";
import {
  readTimeline,
  timelineInput,
  writeTimeline,
} from "../timeline-helpers.js";
import {
  DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS,
  DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT,
} from "../remotion/keyword-graphics.js";

export function renderVideoDef(engine: Engine): ToolDef {
  return {
    name: "render_video",
    description:
      "Render a video artifact into landscape.mp4, portrait.mp4, or square.mp4. Renders all 3 orientations when orientation is omitted.",
    schema: {
      asset_id: z.string().describe("Video artifact id"),
      book_id: z.string().describe("Book id"),
      orientation: z
        .enum(["landscape", "portrait", "square"])
        .optional()
        .describe("Render one orientation; omit to render all three orientations"),
      subtitles_enabled: z
        .boolean()
        .optional()
        .describe("Enable subtitle overlay (default: false)"),
      subtitle_language: z
        .string()
        .regex(/^(original|[a-z]{2})$/)
        .optional()
        .describe("Subtitle language: 'original' or a two-letter ISO 639-1 code (e.g. 'en'). Lazily translates and caches elevenlabs.<lang>.json (default: original)"),
      highlight_style: z
        .enum(["impact", "highlight"])
        .optional()
        .describe("Subtitle animation style (default: impact)"),
      position: z
        .enum(["top", "middle", "bottom"])
        .optional()
        .describe("Subtitle vertical position (default: bottom)"),
      font_size: z
        .enum(["small", "medium", "large"])
        .optional()
        .describe("Subtitle font size (default: medium)"),
      text_color: z
        .string()
        .optional()
        .describe("Subtitle text color hex (default: #F8FAFC)"),
      highlight_color: z
        .string()
        .optional()
        .describe("Active word box color hex for highlight style (default: #991B1B)"),
      audio_fade_in: z
        .number()
        .optional()
        .describe("Audio fade-in in ms (default: 0)"),
      audio_fade_out: z
        .number()
        .optional()
        .describe("Audio fade-out in ms (default: 0)"),
      audio_volume: z
        .number()
        .optional()
        .describe("Audio volume percent 0-100 (default: 100)"),
      osg_asset_id: z
        .string()
        .optional()
        .describe("Image asset ID (img- prefix) for on-screen graphic overlay"),
      osg_position: z
        .enum([
          "top-left", "top-center", "top-right",
          "middle-left", "middle-center", "middle-right",
          "bottom-left", "bottom-center", "bottom-right",
        ])
        .optional()
        .describe("OSG position (default: top-right)"),
      osg_size: z
        .enum(["small", "medium", "large"])
        .optional()
        .describe("OSG size preset; small ≈ half (default: medium)"),
      osg_scale: z
        .number()
        .min(0.1)
        .max(2)
        .optional()
        .describe("OSG size multiplier applied on top of osg_size (default: 1)"),
      osg_opacity: z
        .number()
        .min(0.05)
        .max(1)
        .optional()
        .describe("OSG opacity 0.05-1; the floating watermark uses 0.5 (default: 1)"),
      osg_start_seconds: z
        .number()
        .min(0)
        .nullable()
        .optional()
        .describe("OSG visibility window start in seconds; null/omit ⇒ from clip start"),
      osg_end_seconds: z
        .number()
        .min(0)
        .nullable()
        .optional()
        .describe("OSG visibility window end in seconds; null/omit ⇒ to clip end"),
      osg_tail_seconds: z
        .number()
        .min(0)
        .optional()
        .describe("Legacy: show the OSG only during the last N seconds (end-card); omit for full duration"),
      keyword_graphics_enabled: z
        .boolean()
        .optional()
        .describe("Enable transcript-timed cinematic keyword graphics (default: stored setting or false)"),
      keyword_graphics_max_count: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Maximum automatic keyword graphics (default: stored setting or 8)"),
      keyword_graphics_linger_seconds: z
        .number()
        .min(0.8)
        .max(5)
        .optional()
        .describe("How long each keyword lingers after it is spoken (default: stored setting or 2.4 seconds)"),
      keyword_graphics_keywords: z
        .array(z.string().min(1))
        .max(20)
        .nullable()
        .optional()
        .describe("Exact transcript keywords to animate; null selects keywords automatically"),
      background_mode: z
        .enum(["blur", "black"])
        .optional()
        .describe("Background fill mode (default: blur)"),
      stroke_width: z
        .number()
        .optional()
        .describe("Subtitle stroke width in px, 0-20 (default: 6)"),
      stroke_color: z
        .string()
        .optional()
        .describe("Subtitle stroke color hex (default: #000000)"),
      shadow_blur: z
        .number()
        .optional()
        .describe("Subtitle shadow blur in px, 0-30 (default: 6)"),
      shadow_opacity: z
        .number()
        .optional()
        .describe("Subtitle shadow opacity 0-100 (default: 60)"),
    },
    handler: async (args) => {
      const {
        asset_id,
        book_id,
        orientation: explicitOrientation,
        subtitles_enabled,
        subtitle_language = "original",
        highlight_style = "impact",
        position = "bottom",
        font_size = "medium",
        text_color = "#F8FAFC",
        highlight_color = "#991B1B",
        audio_fade_in = 0,
        audio_fade_out = 0,
        audio_volume = 100,
        osg_asset_id,
        osg_position,
        osg_size,
        osg_scale,
        osg_opacity,
        osg_start_seconds,
        osg_end_seconds,
        osg_tail_seconds,
        keyword_graphics_enabled,
        keyword_graphics_max_count,
        keyword_graphics_linger_seconds,
        keyword_graphics_keywords,
        background_mode = "blur",
        stroke_width = 6,
        stroke_color = "#000000",
        shadow_blur = 6,
        shadow_opacity = 60,
      } = args as {
        asset_id: string;
        book_id: string;
        orientation?: Orientation;
        subtitles_enabled?: boolean;
        subtitle_language?: string;
        highlight_style?: "impact" | "highlight";
        position?: "top" | "middle" | "bottom";
        font_size?: "small" | "medium" | "large";
        text_color?: string;
        highlight_color?: string;
        audio_fade_in?: number;
        audio_fade_out?: number;
        audio_volume?: number;
        osg_asset_id?: string;
        osg_position?: OsgPosition;
        osg_size?: "small" | "medium" | "large";
        osg_scale?: number;
        osg_opacity?: number;
        osg_start_seconds?: number | null;
        osg_end_seconds?: number | null;
        osg_tail_seconds?: number;
        keyword_graphics_enabled?: boolean;
        keyword_graphics_max_count?: number;
        keyword_graphics_linger_seconds?: number;
        keyword_graphics_keywords?: string[] | null;
        background_mode?: "blur" | "black";
        stroke_width?: number;
        stroke_color?: string;
        shadow_blur?: number;
        shadow_opacity?: number;
      };

      const kindGate = await requireArtifactKind(engine, asset_id, ["video"], "render_video");
      if (kindGate) return kindGate;

      if (text_color && !isValidHex(text_color)) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid text_color hex: ${text_color}` }],
        };
      }
      if (highlight_color && !isValidHex(highlight_color)) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid highlight_color hex: ${highlight_color}` }],
        };
      }
      if (audio_volume < 0 || audio_volume > 100) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "audio_volume must be 0-100" }],
        };
      }
      if (audio_fade_in < 0 || audio_fade_out < 0) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "audio fade values must be >= 0" }],
        };
      }
      if (stroke_width < 0 || stroke_width > 20) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "stroke_width must be 0-20" }],
        };
      }
      if (stroke_color && !isValidHex(stroke_color)) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Invalid stroke_color hex: ${stroke_color}` }],
        };
      }
      if (shadow_blur < 0 || shadow_blur > 30) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "shadow_blur must be 0-30" }],
        };
      }
      if (shadow_opacity < 0 || shadow_opacity > 100) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "shadow_opacity must be 0-100" }],
        };
      }

      // Determine orientations to render
      const ALL_ORIENTATIONS: Orientation[] = ["landscape", "portrait", "square"];
      const orientations: Orientation[] = explicitOrientation
        ? [explicitOrientation]
        : ALL_ORIENTATIONS;

      const manifestResult = await engine.files.manifest(asset_id);
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }

      const manifest = manifestResult.value;
      const videoFile = findVideoFile(manifest.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${asset_id}` }],
        };
      }

      const subsEnabled = subtitles_enabled ?? false;

      // Resolve an explicitly passed OSG image up front so a bad reference
      // fails the tool call. Stored per-orientation OSG settings are resolved
      // inside the orientation loop instead (a stale stored id skips the OSG
      // rather than failing the render).
      let osgImagePath: string | null = null;
      if (osg_asset_id) {
        const osgGate = await requireArtifactKind(engine, osg_asset_id, ["image"], "osg_asset_id");
        if (osgGate) return osgGate;
        const resolved = await resolveOsgImagePath(engine, osg_asset_id);
        if (!resolved.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: resolved.error }],
          };
        }
        osgImagePath = resolved.path;
      }
      const storedOsgPathCache = new Map<string, string | null>();

      // A previously failed job leaves the assets row at status='error',
      // which beginAssetWork refuses to lease — and enqueue never resets it.
      // An explicit render is a retry: clear the stale failure first so the
      // new jobs can claim the asset.
      const clearResult = await engine.jobs.failures.clear(asset_id);
      if (!clearResult.ok) {
        logger.warn(`[render] clearing stale generation error for ${asset_id} failed: ${clearResult.error.message}`);
      }

      const assetDir = manifest.path;
      const videoPath = join(assetDir, videoFile.name);
      const jobs: Array<{ job_id: string; orientation: Orientation }> = [];

      for (const orientation of orientations) {
        const storedResult = await engine.metadata.artifacts.read<Record<string, unknown>>(asset_id, `${orientation}.render`
        );
        const stored = storedResult.ok ? storedResult.value : {};
        const storedMaxCount = stored.keywordGraphicsMaxCount;
        const storedLingerSeconds = stored.keywordGraphicsLingerSeconds;
        const storedKeywords = stored.keywordGraphicsKeywords;
        const keywordGraphicsEnabled = keyword_graphics_enabled
          ?? stored.keywordGraphicsEnabled === true;
        const keywordGraphicsMaxCount = keyword_graphics_max_count
          ?? (typeof storedMaxCount === "number" && Number.isInteger(storedMaxCount) && storedMaxCount >= 1 && storedMaxCount <= 20
            ? storedMaxCount
            : DEFAULT_KEYWORD_GRAPHICS_MAX_COUNT);
        const keywordGraphicsLingerSeconds = keyword_graphics_linger_seconds
          ?? (typeof storedLingerSeconds === "number" && storedLingerSeconds >= 0.8 && storedLingerSeconds <= 5
            ? storedLingerSeconds
            : DEFAULT_KEYWORD_GRAPHICS_LINGER_SECONDS);
        const keywordGraphicsKeywords = keyword_graphics_keywords !== undefined
          ? keyword_graphics_keywords
          : Array.isArray(storedKeywords) && storedKeywords.every((keyword) => typeof keyword === "string")
            ? storedKeywords
            : null;

        // Explicit OSG args win; else fall back to the settings set_video_overlay
        // stored on this orientation (position may differ per orientation — the
        // frame-aware watermark picks a corner for each).
        const storedOsgAssetId = typeof stored.osgAssetId === "string" && stored.osgAssetId.length > 0
          ? stored.osgAssetId
          : null;
        let orientOsgAssetId = osg_asset_id ?? storedOsgAssetId;
        let orientOsgImagePath = osgImagePath;
        if (!osg_asset_id && storedOsgAssetId) {
          if (!storedOsgPathCache.has(storedOsgAssetId)) {
            const resolved = await resolveOsgImagePath(engine, storedOsgAssetId);
            if (!resolved.ok) {
              logger.warn(`[render] stored OSG asset ${storedOsgAssetId} skipped: ${resolved.error}`);
            }
            storedOsgPathCache.set(storedOsgAssetId, resolved.ok ? resolved.path : null);
          }
          orientOsgImagePath = storedOsgPathCache.get(storedOsgAssetId) ?? null;
          if (orientOsgImagePath === null) orientOsgAssetId = null;
        }
        const osgPosition = osg_position
          ?? (isOsgPosition(stored.osgPosition) ? stored.osgPosition : "top-right");
        const osgSize = osg_size
          ?? (isOsgSize(stored.osgSize) ? stored.osgSize : "medium");
        const osgScale = osg_scale
          ?? (typeof stored.osgScale === "number" && Number.isFinite(stored.osgScale) ? stored.osgScale : 1);
        const osgOpacity = osg_opacity
          ?? (typeof stored.osgOpacity === "number" && stored.osgOpacity >= 0.05 && stored.osgOpacity <= 1
            ? stored.osgOpacity
            : 1);
        const osgStartSeconds = osg_start_seconds !== undefined
          ? osg_start_seconds
          : typeof stored.osgStartSeconds === "number" ? stored.osgStartSeconds : null;
        const osgEndSeconds = osg_end_seconds !== undefined
          ? osg_end_seconds
          : typeof stored.osgEndSeconds === "number" ? stored.osgEndSeconds : null;
        const osgTailSeconds = osg_tail_seconds !== undefined
          ? osg_tail_seconds
          : typeof stored.osgTailSeconds === "number" ? stored.osgTailSeconds : null;

        const jobId = `render-${asset_id}-${orientation}-${Date.now()}`;
        await queue.enqueue(jobId, {
          type: "render_project",
          bookId: book_id,
          assetId: asset_id,
          orientation,
          assets: [{
            assetId: asset_id,
            assetDir,
            videoPath,
            videoFilename: videoFile.name,
          }],
          subtitlesEnabled: subsEnabled,
          subtitleLanguage: subtitle_language,
          highlightStyle: highlight_style,
          position,
          fontSize: font_size,
          textColor: text_color,
          highlightColor: highlight_color,
          audioFadeIn: audio_fade_in,
          audioFadeOut: audio_fade_out,
          audioVolume: audio_volume,
          osgImagePath: orientOsgImagePath,
          osgAssetId: orientOsgAssetId ?? null,
          osgPosition,
          osgSize,
          osgScale,
          osgOpacity,
          osgStartSeconds,
          osgEndSeconds,
          osgTailSeconds,
          keywordGraphicsEnabled,
          keywordGraphicsMaxCount,
          keywordGraphicsLingerSeconds,
          keywordGraphicsKeywords,
          backgroundMode: background_mode,
          strokeWidth: stroke_width,
          strokeColor: stroke_color,
          shadowBlur: shadow_blur,
          shadowOpacity: shadow_opacity,
        });
        jobs.push({ job_id: jobId, orientation });
      }

      // Persist the requested orientation as the project's timeline render
      // orientation so /final and the viewer agree on what to produce.
      let savedOrientation: Orientation | undefined;
      if (explicitOrientation) {
        try {
          const timeline = readTimeline(engine);
          const updated = await writeTimeline(engine, {
            ...timelineInput(timeline),
            render: explicitOrientation,
          });
          if (!updated.ok) throw new Error(updated.error.message);
          savedOrientation = explicitOrientation;
        } catch (err) {
          logger.warn("Persisting timeline orientation failed (non-fatal):", err);
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id,
            orientations: orientations,
            jobs,
            ...(savedOrientation !== undefined && { timeline_render: savedOrientation }),
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
