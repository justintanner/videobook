import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import type { Orientation, OsgPosition } from "../remotion/subtitles/types.js";
import { writeOsgSettings } from "../osg-settings.js";
import { resolveOsgImagePath } from "../osg-assets.js";
import { requireArtifactKind, toolError } from "./_shared.js";

const OSG_POSITIONS = [
  "top-left", "top-center", "top-right",
  "middle-left", "middle-center", "middle-right",
  "bottom-left", "bottom-center", "bottom-right",
] as const;

const positionEnum = z.enum(OSG_POSITIONS);

/**
 * Persist OSG (on-screen graphic) overlay settings for a video asset WITHOUT
 * triggering a render. The render path later reads these fields from the
 * asset's `.render` metadata. We merge into every orientation's metadata so
 * the badge + render stay consistent regardless of which orientation is
 * rendered; `osg_positions` lets frame-aware callers store a different anchor
 * per orientation.
 */
export function setVideoOverlayDef(engine: Engine): ToolDef {
  return {
    name: "set_video_overlay",
    description:
      "Set or clear the on-screen graphic overlay on a video asset. Persists to the asset's render metadata for all orientations without rendering. Pass osg_asset_id=null to clear.",
    schema: {
      asset_id: z.string().describe("Video asset ID (e.g. vid-my-clip)"),
      book_id: z.string().describe("Book id"),
      osg_asset_id: z
        .string()
        .nullable()
        .describe("Image asset ID (img- prefix) for the overlay, or null to clear the OSG"),
      osg_position: positionEnum.describe("Anchor position (default top-right)"),
      osg_positions: z
        .object({
          landscape: positionEnum.optional(),
          portrait: positionEnum.optional(),
          square: positionEnum.optional(),
        })
        .optional()
        .describe("Per-orientation anchor overrides; unlisted orientations use osg_position"),
      osg_size: z.enum(["small", "medium", "large"]).describe("Size preset"),
      osg_scale: z
        .number()
        .min(0.1)
        .max(2)
        .optional()
        .describe("Size multiplier applied on top of osg_size (default 1)"),
      osg_opacity: z
        .number()
        .min(0.05)
        .max(1)
        .optional()
        .describe("Overlay opacity 0.05-1; the floating watermark uses 0.5 (default 1)"),
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
        book_id: _book_id,
        osg_asset_id,
        osg_position,
        osg_positions,
        osg_size,
        osg_scale,
        osg_opacity,
        osg_start_seconds,
        osg_end_seconds,
        osg_tail_seconds,
      } = args as {
        asset_id: string;
        book_id: string;
        osg_asset_id: string | null;
        osg_position: OsgPosition;
        osg_positions?: Partial<Record<Orientation, OsgPosition>>;
        osg_size: "small" | "medium" | "large";
        osg_scale?: number;
        osg_opacity?: number;
        osg_start_seconds?: number | null;
        osg_end_seconds?: number | null;
        osg_tail_seconds?: number | null;
      };

      const clearing = osg_asset_id == null;
      const targetGate = await requireArtifactKind(engine, asset_id, ["video"], "set_video_overlay");
      if (targetGate) return targetGate;
      if (!clearing) {
        const imageGate = await requireArtifactKind(engine, osg_asset_id, ["image"], "osg_asset_id");
        if (imageGate) return imageGate;
        const image = await resolveOsgImagePath(engine, osg_asset_id);
        if (!image.ok) return toolError(image.error);
      }

      const written = await writeOsgSettings(engine, asset_id, (orientation, base) => {
        const merged: Record<string, unknown> = {
          // osgAssetId is canonical; null out the legacy osgImagePath so a stale
          // path can't override a cleared/changed asset id at render time.
          osgImagePath: null,
          osgAssetId: clearing ? null : osg_asset_id,
          osgPosition: osg_positions?.[orientation] ?? osg_position,
          osgSize: osg_size,
          osgScale: osg_scale ?? (typeof base.osgScale === "number" ? base.osgScale : 1),
          osgOpacity: clearing
            ? 1
            : osg_opacity ?? (typeof base.osgOpacity === "number" ? base.osgOpacity : 1),
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
        const resolved = { ...base, ...merged };
        const start = typeof resolved.osgStartSeconds === "number" ? resolved.osgStartSeconds : 0;
        if (!clearing && typeof resolved.osgEndSeconds === "number" && resolved.osgEndSeconds <= start) {
          throw new Error(`osg_end_seconds must be greater than osg_start_seconds for ${orientation}`);
        }
        return merged;
      });
      if (!written.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: written.error }],
        };
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
                    positions: osg_positions ?? null,
                    size: osg_size,
                    scale: written.settings.landscape.osgScale,
                    opacity: written.settings.landscape.osgOpacity,
                  },
            }),
          },
        ],
      };
    },
  };
}
