import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { RENDER_ORIENTATIONS } from "./sync.js";

const OSG_POSITIONS = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
] as const;

/**
 * Persist OSG (on-screen graphic) overlay settings for a video asset WITHOUT
 * triggering a render. The OSG positioning overlay (client `OsgOverlay`) applies
 * here; the render path later reads these fields from the asset's `.render`
 * metadata. We merge into every orientation's metadata so the badge + render
 * stay consistent regardless of which orientation is rendered.
 */
export function setVideoOverlayDef(fs: Engine): ToolDef {
  return {
    name: "set_video_overlay",
    description:
      "Set or clear the on-screen graphic overlay on a video asset. Persists to the asset's render metadata for all orientations without rendering. Pass osg_asset_id=null to clear.",
    schema: {
      asset_id: z.string().describe("Video asset ID (e.g. vid-my-clip)"),
      project_slug: z.string().describe("Project slug"),
      osg_asset_id: z
        .string()
        .nullable()
        .describe("Image asset ID (img- prefix) for the overlay, or null to clear the OSG"),
      osg_position: z.enum(OSG_POSITIONS).describe("Anchor position (default top-right)"),
      osg_size: z.enum(["small", "medium", "large"]).describe("Size preset"),
      osg_scale: z
        .number()
        .min(0.1)
        .max(2)
        .optional()
        .describe("Size multiplier applied on top of osg_size (default 1)"),
      osg_start_seconds: z
        .number()
        .min(0)
        .nullable()
        .optional()
        .describe("Absolute window start in seconds; null ⇒ from clip start. Omit to leave unchanged"),
      osg_end_seconds: z
        .number()
        .min(0)
        .nullable()
        .optional()
        .describe("Absolute window end in seconds; null ⇒ to clip end. Omit to leave unchanged"),
      osg_tail_seconds: z
        .number()
        .min(0)
        .nullable()
        .optional()
        .describe("Legacy: show the OSG only during the last N seconds; omit to leave unchanged"),
    },
    handler: async (args) => {
      const {
        asset_id,
        project_slug,
        osg_asset_id,
        osg_position,
        osg_size,
        osg_scale,
        osg_start_seconds,
        osg_end_seconds,
        osg_tail_seconds,
      } = args as {
        asset_id: string;
        project_slug: string;
        osg_asset_id: string | null;
        osg_position: (typeof OSG_POSITIONS)[number];
        osg_size: "small" | "medium" | "large";
        osg_scale?: number;
        osg_start_seconds?: number | null;
        osg_end_seconds?: number | null;
        osg_tail_seconds?: number | null;
      };

      const clearing = osg_asset_id == null;

      for (const orient of RENDER_ORIENTATIONS) {
        const existing = await fs.metadata.artifacts.read<Record<string, unknown>>(
          asset_id,
          `${orient}.render`,
          project_slug,
        );
        const base = existing.ok ? existing.value : {};
        const merged: Record<string, unknown> = {
          ...base,
          // osgAssetId is canonical; null out the legacy osgImagePath so a stale
          // path can't override a cleared/changed asset id at render time.
          osgImagePath: null,
          osgAssetId: clearing ? null : osg_asset_id,
          osgPosition: osg_position,
          osgSize: osg_size,
          osgScale: osg_scale ?? (typeof base.osgScale === "number" ? base.osgScale : 1),
        };
        if (osg_start_seconds !== undefined) {
          merged.osgStartSeconds = clearing ? null : osg_start_seconds;
        } else if (clearing) {
          merged.osgStartSeconds = null;
        }
        if (osg_end_seconds !== undefined) {
          merged.osgEndSeconds = clearing ? null : osg_end_seconds;
        } else if (clearing) {
          merged.osgEndSeconds = null;
        }
        // An absolute window supersedes the legacy duration-relative tail.
        const windowProvided = osg_start_seconds !== undefined || osg_end_seconds !== undefined;
        if (osg_tail_seconds !== undefined) {
          merged.osgTailSeconds = clearing ? null : osg_tail_seconds;
        } else if (clearing || windowProvided) {
          merged.osgTailSeconds = null;
        }
        await fs.metadata.artifacts.write(asset_id, `${orient}.render`, merged, project_slug);
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              asset_id,
              osg: clearing
                ? null
                : {
                    assetId: osg_asset_id,
                    position: osg_position,
                    size: osg_size,
                    scale: osg_scale ?? 1,
                  },
            }),
          },
        ],
      };
    },
  };
}
