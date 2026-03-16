import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import { findVideoFile } from "../media-files.js";
import { isValidHex } from "../remotion/util.js";
import type { Orientation } from "../remotion/subtitles/types.js";
import type { ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "webp", "gif", "svg"]);

type TimelineConfig = {
  slots: unknown[];
  render: Orientation;
};

export function renderDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "render",
    description:
      "Render a vid- asset using the project's render orientation from timeline config. Output: landscape.mp4, portrait.mp4, or square.mp4.",
    schema: {
      asset_id: z.string().describe("Asset ID (vid- prefix)"),
      project_slug: z.string().describe("Project slug"),
      subtitles_enabled: z
        .boolean()
        .optional()
        .describe("Enable subtitle overlay (default: true when elevenlabs.json exists)"),
      highlight_style: z
        .enum(["tikdance", "highlight"])
        .optional()
        .describe("Subtitle animation style (default: tikdance)"),
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
    },
    handler: async (args) => {
      const {
        asset_id,
        project_slug,
        subtitles_enabled,
        highlight_style = "tikdance",
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
      } = args as {
        asset_id: string;
        project_slug: string;
        subtitles_enabled?: boolean;
        highlight_style?: "tikdance" | "highlight";
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

      // Read orientation from timeline config
      const timelineResult = await fs.readProjectMeta<TimelineConfig>("timeline", project_slug);
      let orientation: Orientation = "landscape";
      if (timelineResult.ok) {
        const raw = timelineResult.value;
        if (raw && typeof raw === "object" && "render" in raw) {
          const r = raw.render;
          orientation = (Array.isArray(r) ? (r[0] ?? "landscape") : r) as Orientation;
        }
      }

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
            text: `Subtitles enabled for ${orientation} but elevenlabs.json not found in asset ${asset_id}. Transcribe the asset first or set subtitles_enabled=false.`,
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
      const jobId = `render-${asset_id}-${Date.now()}`;

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
        osgPosition: osg_position,
        backgroundMode: background_mode,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id,
            job_id: jobId,
            orientation,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
