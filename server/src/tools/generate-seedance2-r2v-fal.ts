import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalSeedance2p0ReferenceToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRefs, slugify } from "./_fal-shared.js";
import { resolveAudioRef, resolveVideoRef, type RefInput } from "./_seedance2-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { requireAtLeastOne, toolError } from "./_shared.js";

async function resolveVideoRefList(
  fs: Engine,
  rawRefs: readonly string[],
  bookId: string,
): Promise<{ ok: true; inputs: RefInput[]; sourceVideoIds: string[] } | { ok: false; error: string }> {
  const inputs: RefInput[] = [];
  const sourceVideoIds: string[] = [];
  for (const raw of rawRefs) {
    const r = await resolveVideoRef(fs, raw, bookId);
    if (!r.ok) return { ok: false, error: r.error };
    inputs.push(r.value);
    sourceVideoIds.push(r.value.assetId);
  }
  return { ok: true, inputs, sourceVideoIds };
}

async function resolveAudioRefList(
  fs: Engine,
  rawRefs: readonly string[],
  bookId: string,
): Promise<{ ok: true; inputs: RefInput[]; sourceAudioIds: string[] } | { ok: false; error: string }> {
  const inputs: RefInput[] = [];
  const sourceAudioIds: string[] = [];
  for (const raw of rawRefs) {
    const r = await resolveAudioRef(fs, raw, bookId);
    if (!r.ok) return { ok: false, error: r.error };
    inputs.push(r.value);
    sourceAudioIds.push(r.value.assetId);
  }
  return { ok: true, inputs, sourceAudioIds };
}

const base = FalSeedance2p0ReferenceToVideoRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Video description (reference items can be mentioned as @Image1, @Video1, @Audio1, etc.)", { required: true }),
  image_refs: apicityStringArrayField(base.image_urls, "0-9 reference image artifact ids"),
  video_refs: apicityStringArrayField(base.video_urls, "0-3 reference video artifact ids (combined 2-15s)"),
  audio_refs: apicityStringArrayField(base.audio_urls, "0-3 reference audio artifact ids (combined ≤15s)"),
  resolution: apicityField(base.resolution, "Output resolution (default 720p)"),
  duration: apicityField(base.duration, "Duration in seconds or 'auto' (default auto)"),
  aspect_ratio: apicityField(base.aspect_ratio, "Output aspect ratio"),
  generate_audio: apicityField(base.generate_audio, "Generate synchronized audio (default true)"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateSeedance2R2vFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_seedance_2_0_reference_to_video",
    description: "Generate a video via fal.ai using ByteDance Seedance 2.0 Reference-to-Video, guided by reference images, videos, and/or audio. Creates a new video artifact and enqueues a background job. Requires at least one of image_refs, video_refs, or audio_refs (audio alone is not allowed — pair it with an image or video).",
    schema,
    handler: async (args) => {
      const {
        book_id, prompt,
        image_refs, video_refs, audio_refs,
        resolution, duration, aspect_ratio, generate_audio, seed,
      } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return toolError("FAL_API_KEY environment variable is not set");
      }

      const missingInput = requireAtLeastOne("generate_fal_seedance_2_0_reference_to_video", [
        { name: "image_refs", value: image_refs },
        { name: "video_refs", value: video_refs },
        { name: "audio_refs", value: audio_refs },
      ]);
      if (missingInput) return missingInput;

      const imgRefs = image_refs ?? [];
      const vidRefs = video_refs ?? [];
      const audRefs = audio_refs ?? [];

      if (audRefs.length > 0 && imgRefs.length === 0 && vidRefs.length === 0) {
        return toolError("When audio_refs is set, at least one reference image or video is required");
      }
      if (imgRefs.length + vidRefs.length + audRefs.length > 12) {
        return toolError("Total reference files across all modalities must not exceed 12");
      }

      const resolvedImages = await resolveImageRefs(fs, imgRefs, book_id);
      if (!resolvedImages.ok) return toolError(resolvedImages.error);

      const resolvedVideos = await resolveVideoRefList(fs, vidRefs, book_id);
      if (!resolvedVideos.ok) return toolError(resolvedVideos.error);

      const resolvedAudios = await resolveAudioRefList(fs, audRefs, book_id);
      if (!resolvedAudios.ok) return toolError(resolvedAudios.error);

      const assetResult = await fs.artifacts.create("vid", `${modelSlug("kie", "bytedance/seedance-2")}-${slugify(prompt) || String(Date.now())}`);
      if (!assetResult.ok) return toolError(`Failed to create video asset: ${assetResult.error.message}`);

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "bytedance/seedance-2")}-r2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_seedance2_r2v_fal",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
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
