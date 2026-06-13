import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";
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
      "Create the active Clip Show plan from one char-* host with an ElevenLabs voice and one or more vid-* clips. Uses GPT-5.5 to write before/after jokes, dialog, first-frame prompts, and Seedance video prompts. Runs in the background. Writes plan/index.md and plan/.plan.json. Returns immediately; read_plan reports the new plan when it lands.",
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

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      // Cheap pre-check: confirm the host character and clips resolve before
      // enqueuing. Heavy context loading (transcripts, frames) stays in the job.
      const charId = character_asset_id.replace(/^@/, "");
      const charManifest = await fs.getManifest(charId, project_slug, { includeDotfiles: true });
      if (!charManifest.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Host character not found: ${charId}` }],
        };
      }
      for (const clip of clip_asset_ids) {
        const clipId = clip.replace(/^@/, "");
        const clipManifest = await fs.getManifest(clipId, project_slug);
        if (!clipManifest.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Clip not found: ${clipId}` }],
          };
        }
      }

      const jobId = `plan-clip-show-${charId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        // assetId leases/marks the host character (it always exists, and it's
        // the subject of the show) so the asset shows "analyzing" immediately
        // and concurrent generations on the same host are serialized.
        assetId: charId,
        type: "plan_clip_show",
        projectSlug: project_slug,
        characterAssetId: character_asset_id,
        clipAssetIds: clip_asset_ids,
        showBrief: show_brief ?? null,
        tone: tone ?? null,
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ asset_id: "plan", job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}

export type PlanClipShowResult = {
  asset_id: "plan";
  job_id: string;
  status: "enqueued";
};
