import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalWan3p0ReferenceToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRefs } from "./_fal-shared.js";
import { resolveAudioRef, resolveVideoRef, type RefInput } from "./_seedance2-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { requireAtLeastOne, toolError } from "./_shared.js";
import { generationLabel } from "../artifact-label.js";

type ResolveListOk = { ok: true; inputs: RefInput[]; sourceIds: string[] };
type ResolveListErr = { ok: false; error: string };

async function resolveRefList(
  resolve: (engine: Engine, raw: string) => Promise<{ ok: true; value: RefInput } | { ok: false; error: string }>,
  engine: Engine,
  rawRefs: readonly string[],
): Promise<ResolveListOk | ResolveListErr> {
  const inputs: RefInput[] = [];
  const sourceIds: string[] = [];
  for (const raw of rawRefs) {
    const r = await resolve(engine, raw);
    if (!r.ok) return { ok: false, error: r.error };
    inputs.push(r.value);
    sourceIds.push(r.value.assetId);
  }
  return { ok: true, inputs, sourceIds };
}

const base = FalWan3p0ReferenceToVideoRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Video description (optional)"),
  image_refs: apicityStringArrayField(base.reference_image_urls, "Reference image artifact ids (0-10)"),
  video_refs: apicityStringArrayField(base.reference_video_urls, "Reference video artifact ids (0-5, clips 1-15s totaling <= 15s)"),
  audio_refs: apicityStringArrayField(base.reference_audio_urls, "Reference audio artifact ids (0-5)"),
  file_url: apicityStringField(base.file_url, "Optional reference file URL (requires enable_thinking)"),
  web_url: apicityStringField(base.web_url, "Optional public web URL for grounding (requires enable_thinking)"),
  aspect_ratio: apicityField(base.aspect_ratio, "Output aspect ratio"),
  resolution: apicityField(base.resolution, "Output resolution"),
  duration: apicityField(base.duration, "Video duration in seconds (2-30)", { required: true }),
  audio: apicityField(base.audio, "Generate accompanying audio"),
  enable_prompt_expansion: apicityField(base.enable_prompt_expansion, "Enable prompt expansion"),
  enable_thinking: apicityField(base.enable_thinking, "Enable thinking mode"),
  enable_safety_checker: apicityField(base.enable_safety_checker, "Enable safety checker"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan30PrimeR2vFalDef(engine: Engine): ToolDef {
  return {
    name: "generate_fal_wan_3_0_prime_reference_to_video",
    description: "Generate a video via fal.ai using Alibaba Wan 3.0 Prime (higher quality tier) Reference-to-Video guided by reference images, videos, audio, a file URL, a web URL, and/or a prompt. Creates a new video artifact and enqueues a background job. Requires at least one of prompt, image_refs, video_refs, audio_refs, file_url, or web_url.",
    schema,
    handler: async (args) => {
      const {
        book_id, prompt,
        image_refs, video_refs, audio_refs,
        file_url, web_url,
        aspect_ratio, resolution, duration, audio,
        enable_prompt_expansion, enable_thinking, enable_safety_checker, seed,
      } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return toolError("FAL_API_KEY environment variable is not set");
      }

      const missingInput = requireAtLeastOne("generate_fal_wan_3_0_prime_reference_to_video", [
        { name: "prompt", value: prompt },
        { name: "image_refs", value: image_refs },
        { name: "video_refs", value: video_refs },
        { name: "audio_refs", value: audio_refs },
        { name: "file_url", value: file_url },
        { name: "web_url", value: web_url },
      ]);
      if (missingInput) return missingInput;

      const resolvedImages = await resolveImageRefs(engine, image_refs ?? []);
      if (!resolvedImages.ok) return toolError(resolvedImages.error);

      const resolvedVideos = await resolveRefList(resolveVideoRef, engine, video_refs ?? []);
      if (!resolvedVideos.ok) return toolError(resolvedVideos.error);

      const resolvedAudios = await resolveRefList(resolveAudioRef, engine, audio_refs ?? []);
      if (!resolvedAudios.ok) return toolError(resolvedAudios.error);

      const assetResult = await engine.artifacts.create("vid", generationLabel(modelSlug("fal", "alibaba/wan-3.0-prime/text-to-video"), prompt ?? "reference to video"));
      if (!assetResult.ok) return toolError(`Failed to create video asset: ${assetResult.error.message}`);

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("fal", "alibaba/wan-3.0-prime/text-to-video")}-r2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan30_prime_r2v_fal",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        ...(prompt !== undefined ? { prompt } : {}),
        imageInputs: resolvedImages.inputs,
        videoInputs: resolvedVideos.inputs,
        audioInputs: resolvedAudios.inputs,
        sourceImageIds: resolvedImages.sourceImageIds,
        sourceVideoIds: resolvedVideos.sourceIds,
        sourceAudioIds: resolvedAudios.sourceIds,
        ...(file_url !== undefined ? { file_url } : {}),
        ...(web_url !== undefined ? { web_url } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        duration,
        ...(audio !== undefined ? { audio } : {}),
        ...(enable_prompt_expansion !== undefined ? { enable_prompt_expansion } : {}),
        ...(enable_thinking !== undefined ? { enable_thinking } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolvedImages.sourceImageIds, source_videos: resolvedVideos.sourceIds, source_audios: resolvedAudios.sourceIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
