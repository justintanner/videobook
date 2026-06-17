import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { queue } from "../queue.js";
import { CHARACTER_METADATA_KEY, type Character } from "../jobs/extract-character.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  character_asset_id: z.string().describe("Host character asset id (char-*) with an assigned ElevenLabs voice"),
  image_asset_ids: z
    .array(z.string().min(1))
    .min(1)
    .max(12)
    .describe("Pool of img-* images the host jokes about. The model groups them into jokes and lays out each joke's on-screen-graphic (OSG) run."),
  show_brief: z.string().optional().describe("Optional creative direction for the read-through"),
  tone: z.string().optional().describe("Optional comedy tone"),
};

export function planClipShowDef(fs: VideocityFs): ToolDef {
  return {
    name: "plan_clip_show",
    description:
      "Create the active Clip Show plan: a host char-* with an ElevenLabs voice does an audio read-through over a rapid-fire run of on-screen graphics (OSGs). The model groups the dropped img-* pool into jokes, writes each joke, and lays out its OSG run (reused uploads + newly generated graphics). Generated OSGs get prompts but their images are NOT auto-generated — fill them with the plan's Generate images button (generate_clip_show_images) or per-OSG regenerate. Uses GPT-5.5. Runs in the background. Writes plan/index.md and plan/.plan.json. Returns immediately; read_plan reports the new plan when it lands.",
    schema,
    handler: async (args) => {
      const { project_slug, character_asset_id, image_asset_ids, show_brief, tone } = args as {
        project_slug: string;
        character_asset_id: string;
        image_asset_ids: string[];
        show_brief?: string;
        tone?: string;
      };

      if (!process.env.OPENAI_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      // Cheap pre-check: confirm the host character and each image resolve
      // before enqueuing. Heavy work (vision, GPT, image gen) stays in the job.
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
      for (const raw of image_asset_ids) {
        const imgId = raw.replace(/^@/, "");
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
        imageAssetIds: image_asset_ids,
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
