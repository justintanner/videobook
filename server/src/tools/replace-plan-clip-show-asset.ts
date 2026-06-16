import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { readClipShowPlan, writeClipShowPlan } from "../plan-clip-show.js";
import type { ClipShowPlanSidecar } from "../plan-types.js";
import type { ToolDef } from "./tool-def.js";

const schema = {
  project_slug: z.string().describe("Project slug"),
  segment_index: z.number().int().min(0).describe("Zero-based Clip Show segment index"),
  audio_asset_id: z.string().nullable().optional().describe("aud-* voiceover asset generated from the joke (null clears it)"),
  joke: z.string().optional().describe("Updated spoken joke text (ElevenLabs TTS)"),
  joke_notes: z.string().optional().describe("Updated note on the comedic angle"),
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
      "Update one Clip Show read-through segment: its spoken joke text and/or its generated/replaced aud-* voiceover. Writes plan/index.md and plan/.plan.json.",
    schema,
    handler: async (args) => {
      const { project_slug, segment_index, joke, joke_notes } = args as {
        project_slug: string;
        segment_index: number;
        audio_asset_id?: string | null;
        joke?: string;
        joke_notes?: string;
      };

      try {
        const audioAssetId = validatePrefix("audio_asset_id", (args as { audio_asset_id?: string | null }).audio_asset_id, "aud-");
        const sidecar = await readClipShowPlan(fs, project_slug);
        const segment = sidecar.segments[segment_index];
        if (!segment) throw new Error(`Clip Show segment ${segment_index} not found`);
        // Guard against patching a pre-refactor plan (old segments lack joke/kind).
        if (segment.joke === undefined || segment.kind === undefined) {
          throw new Error("This Clip Show plan uses the old format — regenerate it from /templates before editing.");
        }

        const next: ClipShowPlanSidecar = {
          ...sidecar,
          segments: sidecar.segments.map((item, index) => {
            if (index !== segment_index) return item;
            return {
              ...item,
              ...(audioAssetId !== undefined ? { audio_asset_id: audioAssetId } : {}),
              ...(joke !== undefined ? { joke: joke.trim() } : {}),
              ...(joke_notes !== undefined ? { joke_notes: joke_notes.trim() } : {}),
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
