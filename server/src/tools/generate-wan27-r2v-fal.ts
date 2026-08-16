import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7ReferenceToVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRefs } from "./_fal-shared.js";
import { resolveVideoRef, type RefInput } from "./_seedance2-shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { requireAtLeastOne, toolError } from "./_shared.js";
import { generationLabel } from "../artifact-label.js";

async function resolveVideoRefList(
  fs: Engine,
  rawRefs: readonly string[],
): Promise<{ ok: true; inputs: RefInput[]; sourceVideoIds: string[] } | { ok: false; error: string }> {
  const inputs: RefInput[] = [];
  const sourceVideoIds: string[] = [];
  for (const raw of rawRefs) {
    const r = await resolveVideoRef(fs, raw);
    if (!r.ok) return { ok: false, error: r.error };
    inputs.push(r.value);
    sourceVideoIds.push(r.value.assetId);
  }
  return { ok: true, inputs, sourceVideoIds };
}

const base = FalWanV2p7ReferenceToVideoRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Video description", { required: true }),
  image_refs: apicityStringArrayField(base.reference_image_urls, "Reference image artifact ids (optional)"),
  video_refs: apicityStringArrayField(base.reference_video_urls, "Reference video artifact ids (optional)"),
  aspect_ratio: apicityField(base.aspect_ratio, "Output aspect ratio"),
  resolution: apicityField(base.resolution, "Output resolution"),
  duration: apicityField(base.duration, "Video duration in seconds (2-10)"),
  multi_shots: apicityField(base.multi_shots, "Enable multi-shot mode"),
  negative_prompt: apicityStringField(base.negative_prompt, "Things to avoid"),
  enable_safety_checker: apicityField(base.enable_safety_checker, "Enable safety checker"),
  seed: apicityField(base.seed, "Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27R2vFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_wan_2_7_reference_to_video",
    description: "Generate a video via fal.ai using Alibaba Wan v2.7 Reference-to-Video guided by reference images and/or videos. Creates a new video artifact and enqueues a background job. Requires at least one of image_refs or video_refs.",
    schema,
    handler: async (args) => {
      const {
        book_id, prompt,
        image_refs, video_refs,
        aspect_ratio, resolution, duration, multi_shots,
        negative_prompt, enable_safety_checker, seed,
      } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return toolError("FAL_API_KEY environment variable is not set");
      }

      const missingInput = requireAtLeastOne("generate_fal_wan_2_7_reference_to_video", [
        { name: "image_refs", value: image_refs },
        { name: "video_refs", value: video_refs },
      ]);
      if (missingInput) return missingInput;

      const imgRefs = image_refs ?? [];
      const vidRefs = video_refs ?? [];

      const resolvedImages = await resolveImageRefs(fs, imgRefs);
      if (!resolvedImages.ok) return toolError(resolvedImages.error);

      const resolvedVideos = await resolveVideoRefList(fs, vidRefs);
      if (!resolvedVideos.ok) return toolError(resolvedVideos.error);

      const assetResult = await fs.artifacts.create("vid", generationLabel(modelSlug("kie", "wan/2-7-r2v"), prompt));
      if (!assetResult.ok) return toolError(`Failed to create video asset: ${assetResult.error.message}`);

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/2-7-r2v")}-r2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_r2v_fal",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        imageInputs: resolvedImages.inputs,
        videoInputs: resolvedVideos.inputs,
        sourceImageIds: resolvedImages.sourceImageIds,
        sourceVideoIds: resolvedVideos.sourceVideoIds,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(multi_shots !== undefined ? { multi_shots } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: resolvedImages.sourceImageIds, source_videos: resolvedVideos.sourceVideoIds, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
