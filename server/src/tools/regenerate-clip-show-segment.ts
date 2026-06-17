import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import { readClipShowPlan } from "../plan-clip-show.js";
import type { ClipShowPlanSidecar } from "../plan-types.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  segment_index: z.number().int().min(0).describe("Zero-based Clip Show segment index"),
  joke_type: z
    .string()
    .optional()
    .describe("Comedic style id to write the joke in (e.g. observational, one_liner, pun, deadpan, absurdist, roast, self_deprecating, hyperbole, auto). Defaults to the segment's current type."),
  image_asset_id: z
    .string()
    .optional()
    .describe("New img-* source image to add to this joke's pool before regenerating its OSG run (drag-and-drop)."),
};

export function regenerateClipShowSegmentDef(fs: VideocityFs): ToolDef {
  return {
    name: "regenerate_clip_show_segment",
    description:
      "Rewrite one Clip Show joke and its whole on-screen-graphic (OSG) run with GPT-5.5 — optionally in a different joke type and/or with an added/swapped img-* source image. Re-enqueues generated OSG images and clears the joke's now-stale voiceover. Runs in the background and returns the updated plan once written (plan/index.md and plan/.plan.json).",
    schema,
    handler: async (args) => {
      const { project_slug, segment_index, joke_type, image_asset_id } = args as {
        project_slug: string;
        segment_index: number;
        joke_type?: string;
        image_asset_id?: string;
      };

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      try {
        // Cheap pre-checks before enqueuing the GPT call: the plan exists, the
        // segment is real and current-format, and any swapped image resolves.
        const sidecar = await readClipShowPlan(fs, project_slug);
        const segment = sidecar.segments[segment_index];
        if (!segment) throw new Error(`Clip Show segment ${segment_index} not found`);
        if (!Array.isArray(segment.osgs)) {
          throw new Error("This Clip Show plan uses the old format — regenerate it from /templates before editing.");
        }

        const newImageAssetId = image_asset_id ? image_asset_id.replace(/^@/, "").trim() : null;
        if (newImageAssetId) {
          if (!newImageAssetId.startsWith("img-")) {
            throw new Error(`image_asset_id must be an img-* asset, got: ${newImageAssetId}`);
          }
          const imgManifest = await fs.getManifest(newImageAssetId, project_slug);
          if (!imgManifest.ok) throw new Error(`Image not found: ${newImageAssetId}`);
        }

        const jobId = `regen-clip-show-${segment_index}-${Date.now()}`;
        const result = await queue.enqueueAndWait<{ success: boolean; sidecar: ClipShowPlanSidecar }>(jobId, {
          assetId: "plan",
          type: "regenerate_clip_show_segment",
          projectSlug: project_slug,
          segmentIndex: segment_index,
          jokeType: joke_type ?? null,
          newImageAssetId,
        });

        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ asset_id: "plan", sidecar: result.sidecar }),
          }],
        };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: msg }],
        };
      }
    },
  };
}
