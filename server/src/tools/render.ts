import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "../media-files.js";
import { isValidHex } from "../remotion/util.js";
import type { Orientation } from "../remotion/subtitles/types.js";
import type { ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

export function renderDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "render",
    description:
      "Render a vid- asset. Output: landscape.mp4, portrait.mp4, or square.mp4.",
    schema: {
      asset_id: z.string().describe("Asset ID (vid- prefix)"),
      project_slug: z.string().describe("Project slug"),
      orientation: z
        .enum(["landscape", "portrait", "square"])
        .optional()
        .describe("Render orientation (default: from timeline config, or landscape)"),
      subtitles_enabled: z
        .boolean()
        .optional()
        .describe("Enable subtitle overlay (default: true when elevenlabs.json exists)"),
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
        .describe("Audio fade-in in ms (default: 150)"),
      audio_fade_out: z
        .number()
        .optional()
        .describe("Audio fade-out in ms (default: 100)"),
      audio_volume: z
        .number()
        .optional()
        .describe("Audio volume percent 0-100 (default: 100)"),
      osg_asset_id: z
        .string()
        .optional()
        .describe("Image asset ID (img- prefix) for on-screen graphic overlay"),
      osg_position: z
        .enum(["top-left", "top-right", "bottom-left", "bottom-right"])
        .optional()
        .describe("OSG position (default: top-right)"),
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
        project_slug,
        orientation: explicitOrientation,
        subtitles_enabled,
        highlight_style = "impact",
        position = "bottom",
        font_size = "medium",
        text_color = "#F8FAFC",
        highlight_color = "#991B1B",
        audio_fade_in = 150,
        audio_fade_out = 100,
        audio_volume = 100,
        osg_asset_id,
        osg_position = "top-right",
        background_mode = "blur",
        stroke_width = 6,
        stroke_color = "#000000",
        shadow_blur = 6,
        shadow_opacity = 60,
      } = args as {
        asset_id: string;
        project_slug: string;
        orientation?: Orientation;
        subtitles_enabled?: boolean;
        highlight_style?: "impact" | "highlight";
        position?: "top" | "middle" | "bottom";
        font_size?: "small" | "medium" | "large";
        text_color?: string;
        highlight_color?: string;
        audio_fade_in?: number;
        audio_fade_out?: number;
        audio_volume?: number;
        osg_asset_id?: string;
        osg_position?: "top-left" | "top-right" | "bottom-left" | "bottom-right";
        background_mode?: "blur" | "black";
        stroke_width?: number;
        stroke_color?: string;
        shadow_blur?: number;
        shadow_opacity?: number;
      };

      if (!asset_id.startsWith("vid-")) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "asset_id must start with vid-" }],
        };
      }

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

      const manifestResult = await fs.getManifest(asset_id, project_slug);
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

      const hasElevenlabs = manifest.files.some((f) => f.name === "elevenlabs.json");

      const subsEnabled =
        subtitles_enabled !== undefined
          ? subtitles_enabled
          : hasElevenlabs;

      if (subsEnabled && !hasElevenlabs) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Subtitles enabled but elevenlabs.json not found in asset ${asset_id}. Transcribe the asset first or set subtitles_enabled=false.`,
          }],
        };
      }

      // Resolve OSG image
      let osgImagePath: string | null = null;
      if (osg_asset_id) {
        if (!osg_asset_id.startsWith("img-")) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: "osg_asset_id must start with img-" }],
          };
        }
        const osgManifest = await fs.getManifest(osg_asset_id, project_slug);
        if (!osgManifest.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `OSG asset error: ${osgManifest.error.message}` }],
          };
        }
        const imgFile = osgManifest.value.files.find((f) => {
          const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
          return IMAGE_EXTENSIONS.has(ext);
        });
        if (!imgFile) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `No image file found in OSG asset ${osg_asset_id}` }],
          };
        }
        osgImagePath = join(osgManifest.value.path, imgFile.name);
      }

      const assetDir = manifest.path;
      const videoPath = join(assetDir, videoFile.name);
      const jobs: Array<{ job_id: string; orientation: Orientation }> = [];

      for (const orientation of orientations) {
        const jobId = `render-${asset_id}-${orientation}-${Date.now()}`;
        await queue.enqueue(jobId, {
          type: "render_project",
          projectSlug: project_slug,
          orientation,
          assets: [{
            assetId: asset_id,
            assetDir,
            videoPath,
            videoFilename: videoFile.name,
            hasElevenlabs,
          }],
          subtitlesEnabled: subsEnabled,
          highlightStyle: highlight_style,
          position,
          fontSize: font_size,
          textColor: text_color,
          highlightColor: highlight_color,
          audioFadeIn: audio_fade_in,
          audioFadeOut: audio_fade_out,
          audioVolume: audio_volume,
          osgImagePath,
          osgAssetId: osg_asset_id ?? null,
          osgPosition: osg_position,
          backgroundMode: background_mode,
          strokeWidth: stroke_width,
          strokeColor: stroke_color,
          shadowBlur: shadow_blur,
          shadowOpacity: shadow_opacity,
        });
        jobs.push({ job_id: jobId, orientation });
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id,
            orientations: orientations,
            jobs,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
