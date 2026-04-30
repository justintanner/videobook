import type { ClipfirstFs } from "clipfirst-engine";
import { z, type ZodRawShape } from "zod";
import { FalSeedance2p0FastReferenceToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "clipfirst-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";

type MediaInput = { assetId: string; filename: string };

async function resolveVideoSlugs(
  fs: ClipfirstFs,
  rawSlugs: readonly string[],
  projectSlug: string,
): Promise<{ ok: true; inputs: MediaInput[]; sourceVideoIds: string[] } | { ok: false; error: string }> {
  const inputs: MediaInput[] = [];
  const sourceVideoIds: string[] = [];
  for (const raw of rawSlugs) {
    const assetId = raw.replace(/^@/, "");
    if (!assetId.startsWith("vid-")) return { ok: false, error: `video_slugs entries must be vid-* assets, got: ${assetId}` };
    const manifest = await fs.getManifest(assetId, projectSlug);
    if (!manifest.ok) return { ok: false, error: manifest.error.message };
    const file = findVideoFile(manifest.value.files);
    if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
    inputs.push({ assetId, filename: file.name });
    sourceVideoIds.push(assetId);
  }
  return { ok: true, inputs, sourceVideoIds };
}

async function resolveAudioSlugs(
  fs: ClipfirstFs,
  rawSlugs: readonly string[],
  projectSlug: string,
): Promise<{ ok: true; inputs: MediaInput[]; sourceAudioIds: string[] } | { ok: false; error: string }> {
  const inputs: MediaInput[] = [];
  const sourceAudioIds: string[] = [];
  for (const raw of rawSlugs) {
    const assetId = raw.replace(/^@/, "");
    if (!assetId.startsWith("aud-")) return { ok: false, error: `audio_slugs entries must be aud-* assets, got: ${assetId}` };
    const manifest = await fs.getManifest(assetId, projectSlug);
    if (!manifest.ok) return { ok: false, error: manifest.error.message };
    const file = findAudioFile(manifest.value.files, assetId);
    if (!file) return { ok: false, error: `No audio file found in asset ${assetId}` };
    inputs.push({ assetId, filename: file.name });
    sourceAudioIds.push(assetId);
  }
  return { ok: true, inputs, sourceAudioIds };
}

const base = FalSeedance2p0FastReferenceToVideoRequestSchema.shape;
const resolutionOptions = base.resolution.unwrap().options as readonly [string, ...string[]];
const durationOptions = base.duration.unwrap().options as readonly [string, ...string[]];
const aspectRatioOptions = base.aspect_ratio.unwrap().options as readonly [string, ...string[]];

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description (reference items can be mentioned as @Image1, @Video1, @Audio1, etc.)"),
  image_slugs: z.array(z.string()).max(9).optional().describe("0-9 reference image @slugs"),
  video_slugs: z.array(z.string()).max(3).optional().describe("0-3 reference video @slugs (combined 2-15s)"),
  audio_slugs: z.array(z.string()).max(3).optional().describe("0-3 reference audio @slugs (combined ≤15s)"),
  resolution: z.enum(resolutionOptions).optional().describe("Output resolution (default 720p)"),
  duration: z.enum(durationOptions).optional().describe("Duration in seconds or 'auto' (default auto)"),
  aspect_ratio: z.enum(aspectRatioOptions).optional().describe("Output aspect ratio"),
  generate_audio: z.boolean().optional().describe("Generate synchronized audio (default true)"),
  seed: z.number().int().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateSeedance2FastR2vFalDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "generate_seedance2_fast_r2v_fal",
    description: "Generate a video via fal.ai using ByteDance Seedance 2.0 Fast Reference-to-Video, guided by reference images, videos, and/or audio. Creates a new vid- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const {
        project_slug, prompt,
        image_slugs, video_slugs, audio_slugs,
        resolution, duration, aspect_ratio, generate_audio, seed,
      } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const imgSlugs = image_slugs ?? [];
      const vidSlugs = video_slugs ?? [];
      const audSlugs = audio_slugs ?? [];

      if (imgSlugs.length === 0 && vidSlugs.length === 0 && audSlugs.length === 0) {
        return { isError: true as const, content: [{ type: "text" as const, text: "Seedance 2.0 Fast Reference requires at least one reference image, video, or audio" }] };
      }
      if (audSlugs.length > 0 && imgSlugs.length === 0 && vidSlugs.length === 0) {
        return { isError: true as const, content: [{ type: "text" as const, text: "When audio_slugs is set, at least one reference image or video is required" }] };
      }
      if (imgSlugs.length + vidSlugs.length + audSlugs.length > 12) {
        return { isError: true as const, content: [{ type: "text" as const, text: "Total reference files across all modalities must not exceed 12" }] };
      }

      const resolvedImages = await resolveImageSlugs(fs, imgSlugs, project_slug);
      if (!resolvedImages.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolvedImages.error }] };

      const resolvedVideos = await resolveVideoSlugs(fs, vidSlugs, project_slug);
      if (!resolvedVideos.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolvedVideos.error }] };

      const resolvedAudios = await resolveAudioSlugs(fs, audSlugs, project_slug);
      if (!resolvedAudios.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolvedAudios.error }] };

      const assetResult = await fs.createAsset("vid", `seedance2-fast-ref-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-seedance2-fast-r2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_seedance2_fast_r2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        imageInputs: resolvedImages.inputs,
        videoInputs: resolvedVideos.inputs,
        audioInputs: resolvedAudios.inputs,
        sourceImageIds: resolvedImages.sourceImageIds,
        sourceVideoIds: resolvedVideos.sourceVideoIds,
        sourceAudioIds: resolvedAudios.sourceAudioIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolvedImages.sourceImageIds, source_videos: resolvedVideos.sourceVideoIds, source_audios: resolvedAudios.sourceAudioIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
