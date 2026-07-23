import type { VideocityFs } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalSeedance2p0FastReferenceToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { findAudioFile, findVideoFile } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { requireAtLeastOne, toolError } from "./_shared.js";

type MediaInput = { assetId: string; filename: string };

async function resolveVideoSlugs(
  fs: VideocityFs,
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
  fs: VideocityFs,
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

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(base.prompt, "Video description (reference items can be mentioned as @Image1, @Video1, @Audio1, etc.)", { required: true }),
  image_slugs: apicityStringArrayField(base.image_urls, "0-9 reference image @slugs"),
  video_slugs: apicityStringArrayField(base.video_urls, "0-3 reference video @slugs (combined 2-15s)"),
  audio_slugs: apicityStringArrayField(base.audio_urls, "0-3 reference audio @slugs (combined ≤15s)"),
  resolution: apicityField(base.resolution, "Output resolution (default 720p)"),
  duration: apicityField(base.duration, "Duration in seconds or 'auto' (default auto)"),
  aspect_ratio: apicityField(base.aspect_ratio, "Output aspect ratio"),
  generate_audio: apicityField(base.generate_audio, "Generate synchronized audio (default true)"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateSeedance2FastR2vFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_fal_seedance_2_0_fast_reference_to_video",
    description: "Generate a video via fal.ai using ByteDance Seedance 2.0 Fast Reference-to-Video, guided by reference images, videos, and/or audio. Creates a new vid- asset and enqueues a background job. Requires at least one of image_slugs, video_slugs, or audio_slugs (audio alone is not allowed — pair it with an image or video).",
    schema,
    handler: async (args) => {
      const {
        project_slug, prompt,
        image_slugs, video_slugs, audio_slugs,
        resolution, duration, aspect_ratio, generate_audio, seed,
      } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return toolError("FAL_API_KEY environment variable is not set");
      }

      const missingInput = requireAtLeastOne("generate_fal_seedance_2_0_fast_reference_to_video", [
        { name: "image_slugs", value: image_slugs },
        { name: "video_slugs", value: video_slugs },
        { name: "audio_slugs", value: audio_slugs },
      ]);
      if (missingInput) return missingInput;

      const imgSlugs = image_slugs ?? [];
      const vidSlugs = video_slugs ?? [];
      const audSlugs = audio_slugs ?? [];

      if (audSlugs.length > 0 && imgSlugs.length === 0 && vidSlugs.length === 0) {
        return toolError("When audio_slugs is set, at least one reference image or video is required");
      }
      if (imgSlugs.length + vidSlugs.length + audSlugs.length > 12) {
        return toolError("Total reference files across all modalities must not exceed 12");
      }

      const resolvedImages = await resolveImageSlugs(fs, imgSlugs, project_slug);
      if (!resolvedImages.ok) return toolError(resolvedImages.error);

      const resolvedVideos = await resolveVideoSlugs(fs, vidSlugs, project_slug);
      if (!resolvedVideos.ok) return toolError(resolvedVideos.error);

      const resolvedAudios = await resolveAudioSlugs(fs, audSlugs, project_slug);
      if (!resolvedAudios.ok) return toolError(resolvedAudios.error);

      const assetResult = await fs.createAsset("vid", `${modelSlug("kie", "bytedance/seedance-2-fast")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return toolError(`Failed to create video asset: ${assetResult.error.message}`);

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "bytedance/seedance-2-fast")}-r2v-${vidAssetId}-${Date.now()}`;
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
