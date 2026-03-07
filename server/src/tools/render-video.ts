import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs, AssetManifestFile } from "clipfirst-fs";
import { z } from "zod";
import { join, extname } from "node:path";
import { queue } from "../queue.js";
import { isValidHex } from "../remotion/util.js";
import type { ToolDef } from "./tool-def.js";

const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "webm", "avi", "mkv"]);

function findVideoFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const videos = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return VIDEO_EXTENSIONS.has(ext);
  });
  return videos.find((f) => f.name.startsWith("original")) ?? videos[0] ?? null;
}

export function renderVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "render_video",
    description:
      "Render a vid- asset to portrait (1080x1920) and/or landscape (1920x1080) with blur-fill background and optional word-level subtitles. Produces render_9x16.mp4 and/or render_16x9.mp4.",
    schema: {
      asset_id: z.string().describe("Asset ID (vid- prefix)"),
      project_slug: z.string().describe("Project slug"),
      orientation: z
        .enum(["landscape", "portrait", "both"])
        .optional()
        .describe("Which versions to render (default: both)"),
      subtitles_enabled: z
        .boolean()
        .optional()
        .describe("Enable subtitle overlay (default: portrait=true, landscape=false)"),
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
    },
    handler: async (args) => {
      const {
        asset_id,
        project_slug,
        orientation = "both",
        subtitles_enabled,
        highlight_style = "tikdance",
        position = "bottom",
        font_size = "medium",
        text_color = "#F8FAFC",
        highlight_color = "#991B1B",
        audio_fade_in = 150,
        audio_fade_out = 100,
        audio_volume = 100,
      } = args as {
        asset_id: string;
        project_slug: string;
        orientation?: "landscape" | "portrait" | "both";
        subtitles_enabled?: boolean;
        highlight_style?: "tikdance" | "highlight";
        position?: "top" | "middle" | "bottom";
        font_size?: "small" | "medium" | "large";
        text_color?: string;
        highlight_color?: string;
        audio_fade_in?: number;
        audio_fade_out?: number;
        audio_volume?: number;
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

      const orientations: ("landscape" | "portrait")[] =
        orientation === "both"
          ? ["landscape", "portrait"]
          : [orientation];

      for (const orient of orientations) {
        const subsEnabled =
          subtitles_enabled !== undefined
            ? subtitles_enabled
            : orient === "portrait";

        if (subsEnabled && !hasElevenlabs) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Subtitles enabled for ${orient} but elevenlabs.json not found in asset ${asset_id}. Transcribe the asset first or set subtitles_enabled=false.`,
            }],
          };
        }
      }

      const assetDir = manifest.path;
      const videoPath = join(assetDir, videoFile.name);
      const jobId = `render-${asset_id}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "render_video",
        assetId: asset_id,
        assetDir,
        videoPath,
        videoFilename: videoFile.name,
        projectSlug: project_slug,
        orientations,
        subtitlesEnabled: subtitles_enabled,
        highlightStyle: highlight_style,
        position,
        fontSize: font_size,
        textColor: text_color,
        highlightColor: highlight_color,
        audioFadeIn: audio_fade_in,
        audioFadeOut: audio_fade_out,
        audioVolume: audio_volume,
        hasElevenlabs,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            asset_id,
            job_id: jobId,
            orientations,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}

export function registerRenderVideoTool(server: McpServer, fs: ClipfirstFs): void {
  const def = renderVideoDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
