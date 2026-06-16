import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import { CHARACTER_METADATA_KEY, type Character } from "../jobs/extract-character.js";
import type { ClipShowItem } from "../plan-types.js";
import type { ToolDef } from "./tool-def.js";

const itemSchema = z.union([
  z.object({ kind: z.literal("topic"), topic: z.string().min(1) }),
  z.object({ kind: z.literal("image"), image_asset_id: z.string().min(1) }),
]);

const schema = {
  project_slug: z.string().describe("Project slug"),
  character_asset_id: z.string().describe("Host character asset id (char-*) with an assigned ElevenLabs voice"),
  items: z
    .array(itemSchema)
    .min(1)
    .max(12)
    .describe("Ordered items the host jokes about — each a {kind:'topic',topic} or {kind:'image',image_asset_id} (img-*)"),
  show_brief: z.string().optional().describe("Optional creative direction for the read-through"),
  tone: z.string().optional().describe("Optional comedy tone"),
};

export function planClipShowDef(fs: VideocityFs): ToolDef {
  return {
    name: "plan_clip_show",
    description:
      "Create the active Clip Show plan: a host char-* with an ElevenLabs voice does an audio read-through, writing one joke per item (each item a text topic or an img-* image, read via vision). Uses GPT-5.5. Runs in the background. Writes plan/index.md and plan/.plan.json. Returns immediately; read_plan reports the new plan when it lands.",
    schema,
    handler: async (args) => {
      const {
        project_slug,
        character_asset_id,
        items,
        show_brief,
        tone,
      } = args as {
        project_slug: string;
        character_asset_id: string;
        items: ClipShowItem[];
        show_brief?: string;
        tone?: string;
      };

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      // Cheap pre-check: confirm the host character and any image items resolve
      // before enqueuing. Heavy work (vision, GPT) stays in the job.
      const charId = character_asset_id.replace(/^@/, "");
      const charManifest = await fs.getManifest(charId, project_slug, { includeDotfiles: true });
      if (!charManifest.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Host character not found: ${charId}` }],
        };
      }
      // Voice is required to narrate the show. The background job also enforces
      // this, but checking here returns an actionable error immediately instead
      // of failing silently mid-job (the client would otherwise poll for ~5 min).
      const charMeta = await fs.readMetadata<Character>(charId, CHARACTER_METADATA_KEY, project_slug);
      if (!charMeta.ok || !charMeta.value.elevenlabs_voice_id?.trim()) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Host character @${charId} has no ElevenLabs voice assigned. Assign a voice in the character editor, or pick a different host under Customize.`,
          }],
        };
      }
      for (const item of items) {
        if (item.kind !== "image") continue;
        const imgId = item.image_asset_id.replace(/^@/, "");
        const imgManifest = await fs.getManifest(imgId, project_slug);
        if (!imgManifest.ok) {
          return {
            isError: true as const,
            content: [{ type: "text" as const, text: `Image not found: ${imgId}` }],
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
        items,
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
