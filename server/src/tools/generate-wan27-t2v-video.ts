import type { ClipfirstFs } from "clipfirst-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { Wan27AspectRatioSchema, Wan27ResolutionSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { findAudioFile } from "clipfirst-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

type RefInput = { assetId: string; filename: string };
type ResolveOk = { ok: true; value: RefInput };
type ResolveErr = { ok: false; error: string };

async function resolveAudioSlug(fs: ClipfirstFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("aud-")) return { ok: false, error: `audio_slug must be an aud-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findAudioFile(manifest.value.files, assetId);
  if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

const generateWan27T2vVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description (max 5000 chars)"),
  negative_prompt: z.string().optional().describe("Negative prompt — things to avoid (max 500 chars)"),
  audio_slug: z.string().optional().describe("Optional custom audio asset (e.g., @aud-music)"),
  resolution: z.enum(Wan27ResolutionSchema.options).optional().describe("Video resolution (default 1080p)"),
  aspect_ratio: z.enum(Wan27AspectRatioSchema.options).optional().describe("Video aspect ratio"),
  duration: z.string().optional().describe("Video duration in seconds (2-15)"),
  prompt_extend: z.boolean().optional().describe("Intelligent prompt rewriting (default true)"),
  watermark: z.boolean().optional().describe("Add provider watermark to output (default false)"),
  nsfw_checker: z.boolean().optional().describe("Content safety filter (default false)"),
  seed: z.number().int().optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateWan27T2vVideoSchema>;

export function generateWan27T2vVideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_wan27_t2v_video",
    description: "Generate a video from a prompt using Wan 2.7 Text to Video. Supports optional custom audio. Creates a new vid- asset and enqueues a background job.",
    schema: generateWan27T2vVideoSchema,
    handler: async (args) => {
      const {
        project_slug, prompt, negative_prompt, audio_slug,
        resolution, aspect_ratio, duration, prompt_extend, watermark, nsfw_checker, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      let audioRef: RefInput | undefined;
      if (audio_slug) {
        const r = await resolveAudioSlug(fs, audio_slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        audioRef = r.value;
      }

      const videoName = `${modelSlug("kie", "wan/2-7-text-to-video")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceAudioIds = audioRef ? [audioRef.assetId] : [];

      const jobId = `${modelSlug("kie", "wan/2-7-text-to-video")}-t2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_wan27_t2v_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(audioRef ? { audioRef } : {}),
        sourceAudioIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(prompt_extend !== undefined ? { prompt_extend } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
        ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_audios: sourceAudioIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
