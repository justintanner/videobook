import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7EditVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { findVideoFile } from "videocity-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import { apicityField } from "./schema-from-apicity.js";
import { requireAtLeastOne, toolError } from "./_shared.js";

type VideoInput = { assetId: string; filename: string };

async function resolveVideoSlugs(
  fs: VideocityFs,
  rawSlugs: readonly string[],
  projectSlug: string,
): Promise<{ ok: true; inputs: VideoInput[]; sourceVideoIds: string[] } | { ok: false; error: string }> {
  const inputs: VideoInput[] = [];
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

const editBase = FalWanV2p7EditVideoRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description"),
  image_slugs: z.array(z.string()).optional().describe("Reference image @slugs (optional)"),
  video_slugs: z.array(z.string()).optional().describe("Reference video @slugs (optional)"),
  aspect_ratio: apicityField(editBase.aspect_ratio, "Output aspect ratio"),
  resolution: apicityField(editBase.resolution, "Output resolution"),
  duration: z.number().int().min(2).max(15).optional().describe("Video duration in seconds"),
  multi_shots: z.boolean().optional().describe("Enable multi-shot mode"),
  negative_prompt: z.string().optional().describe("Things to avoid"),
  enable_safety_checker: z.boolean().optional().describe("Enable safety checker"),
  seed: z.number().int().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27R2vFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_wan27_r2v_fal",
    description: "Generate a video via fal.ai using Alibaba Wan v2.7 Reference-to-Video guided by reference images and/or videos. Creates a new vid- asset and enqueues a background job. Requires at least one of image_slugs or video_slugs.",
    schema,
    handler: async (args) => {
      const {
        project_slug, prompt,
        image_slugs, video_slugs,
        aspect_ratio, resolution, duration, multi_shots,
        negative_prompt, enable_safety_checker, seed,
      } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return toolError("FAL_API_KEY environment variable is not set");
      }

      const missingInput = requireAtLeastOne("generate_wan27_r2v_fal", [
        { name: "image_slugs", value: image_slugs },
        { name: "video_slugs", value: video_slugs },
      ]);
      if (missingInput) return missingInput;

      const imgSlugs = image_slugs ?? [];
      const vidSlugs = video_slugs ?? [];

      const resolvedImages = await resolveImageSlugs(fs, imgSlugs, project_slug);
      if (!resolvedImages.ok) return toolError(resolvedImages.error);

      const resolvedVideos = await resolveVideoSlugs(fs, vidSlugs, project_slug);
      if (!resolvedVideos.ok) return toolError(resolvedVideos.error);

      const assetResult = await fs.createAsset("vid", `${modelSlug("kie", "wan/2-7-r2v")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return toolError(`Failed to create video asset: ${assetResult.error.message}`);

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/2-7-r2v")}-r2v-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_r2v_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
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
