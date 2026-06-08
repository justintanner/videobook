import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { readClipShowPlan, writeClipShowPlan } from "../plan-clip-show.js";
import type { ClipShowPlanSidecar } from "../plan-types.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  segment_index: z.number().int().min(0).describe("Zero-based Clip Show segment index"),
  audio_asset_id: z.string().nullable().optional().describe("aud-* asset generated from the segment dialog"),
  first_frame_asset_id: z.string().nullable().optional().describe("img-* first-frame asset for the segment host video"),
  video_asset_id: z.string().nullable().optional().describe("vid-* Seedance segment video asset"),
  intro_dialog: z.string().optional().describe("Updated before-clip joke text"),
  outro_dialog: z.string().optional().describe("Updated after-clip joke text"),
  dialog: z.string().optional().describe("Updated combined TTS dialog"),
  first_frame_prompt: z.string().optional().describe("Updated first-frame prompt"),
  video_prompt: z.string().optional().describe("Updated Seedance prompt"),
};

function normalizeAssetId(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.replace(/^@/, "").trim();
  return trimmed || null;
}

function validatePrefix(label: string, value: string | null | undefined, prefix: string): string | null | undefined {
  const normalized = normalizeAssetId(value);
  if (normalized === undefined || normalized === null) return normalized;
  if (!normalized.startsWith(prefix)) throw new Error(`${label} must start with ${prefix}, got: ${normalized}`);
  return normalized;
}

export function replacePlanClipShowAssetDef(fs: VideocityFs): ToolDef {
  return {
    name: "replace_plan_clip_show_asset",
    description:
      "Update one Clip Show plan segment with generated/replaced audio, first-frame, video asset IDs, or edited dialog/prompts. Writes plan/index.md and plan/.plan.json.",
    schema,
    handler: async (args) => {
      const {
        project_slug,
        segment_index,
        intro_dialog,
        outro_dialog,
        dialog,
        first_frame_prompt,
        video_prompt,
      } = args as {
        project_slug: string;
        segment_index: number;
        audio_asset_id?: string | null;
        first_frame_asset_id?: string | null;
        video_asset_id?: string | null;
        intro_dialog?: string;
        outro_dialog?: string;
        dialog?: string;
        first_frame_prompt?: string;
        video_prompt?: string;
      };

      try {
        const audioAssetId = validatePrefix("audio_asset_id", (args as { audio_asset_id?: string | null }).audio_asset_id, "aud-");
        const firstFrameAssetId = validatePrefix("first_frame_asset_id", (args as { first_frame_asset_id?: string | null }).first_frame_asset_id, "img-");
        const videoAssetId = validatePrefix("video_asset_id", (args as { video_asset_id?: string | null }).video_asset_id, "vid-");
        const sidecar = await readClipShowPlan(fs, project_slug);
        const segment = sidecar.segments[segment_index];
        if (!segment) throw new Error(`Clip Show segment ${segment_index} not found`);

        const next: ClipShowPlanSidecar = {
          ...sidecar,
          video_model: "generate_seedance2_video",
          segments: sidecar.segments.map((item, index) => {
            if (index !== segment_index) return item;
            return {
              ...item,
              ...(audioAssetId !== undefined ? { audio_asset_id: audioAssetId } : {}),
              ...(firstFrameAssetId !== undefined ? { first_frame_asset_id: firstFrameAssetId } : {}),
              ...(videoAssetId !== undefined ? { video_asset_id: videoAssetId } : {}),
              ...(intro_dialog !== undefined ? { intro_dialog: intro_dialog.trim() } : {}),
              ...(outro_dialog !== undefined ? { outro_dialog: outro_dialog.trim() } : {}),
              ...(dialog !== undefined ? { dialog: dialog.trim() } : {}),
              ...(first_frame_prompt !== undefined ? { first_frame_prompt: first_frame_prompt.trim() } : {}),
              ...(video_prompt !== undefined ? { video_prompt: video_prompt.trim() } : {}),
            };
          }),
        };

        await writeClipShowPlan(fs, project_slug, next);
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              asset_id: "plan",
              sidecar: next,
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
