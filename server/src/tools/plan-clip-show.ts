import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { generateClipShowPlan } from "../plan-clip-show.js";
import type { ClipShowPlanSidecar } from "../plan-types.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  character_asset_id: z.string().describe("Host character asset id (char-*) with an assigned ElevenLabs voice"),
  clip_asset_ids: z.array(z.string()).min(1).max(8).describe("Ordered video clips (vid-*) to talk about"),
  show_brief: z.string().optional().describe("Optional creative direction for the clip show"),
  tone: z.string().optional().describe("Optional comedy tone"),
};

export function planClipShowDef(fs: VideocityFs): ToolDef {
  return {
    name: "plan_clip_show",
    description:
      "Create the active Clip Show plan from one char-* host with an ElevenLabs voice and one or more vid-* clips. Uses GPT-5.5 to write before/after jokes, dialog, first-frame prompts, and Seedance video prompts. Writes plan/index.md and plan/.plan.json.",
    schema,
    handler: async (args) => {
      const {
        project_slug,
        character_asset_id,
        clip_asset_ids,
        show_brief,
        tone,
      } = args as {
        project_slug: string;
        character_asset_id: string;
        clip_asset_ids: string[];
        show_brief?: string;
        tone?: string;
      };

      try {
        const sidecar = await generateClipShowPlan(fs, {
          projectSlug: project_slug,
          characterAssetId: character_asset_id,
          clipAssetIds: clip_asset_ids,
          ...(show_brief !== undefined ? { showBrief: show_brief } : {}),
          ...(tone !== undefined ? { tone } : {}),
        });
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asset_id: "plan",
              sidecar,
            }),
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

export type PlanClipShowResult = {
  asset_id: "plan";
  sidecar: ClipShowPlanSidecar;
};
