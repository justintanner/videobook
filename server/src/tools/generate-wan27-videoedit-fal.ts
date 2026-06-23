import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { FalWanV2p7EditVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { findVideoFile } from "videocity-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlugs, slugify } from "./_fal-shared.js";
import type { ImageInput } from "./_image-inputs.js";
import { apicityField } from "./schema-from-apicity.js";

const editBase = FalWanV2p7EditVideoRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Edit instruction"),
  video_slug: z.string().describe("Source video asset to edit (e.g., @vid-scene)"),
  image_slug: z.string().optional().describe("Optional reference image for character/style guidance"),
  aspect_ratio: apicityField(editBase.aspect_ratio, "Output aspect ratio"),
  resolution: apicityField(editBase.resolution, "Output resolution"),
  duration: z.number().int().min(2).max(15).optional().describe("Video duration in seconds"),
  audio_setting: apicityField(editBase.audio_setting, "Audio: auto or origin"),
  negative_prompt: z.string().optional().describe("Things to avoid"),
  enable_safety_checker: z.boolean().optional().describe("Enable safety checker"),
  seed: z.number().int().optional().describe("Seed for deterministic output"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateWan27VideoeditFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_wan27_videoedit_fal",
    description: "Edit a video via fal.ai using Alibaba Wan v2.7 Edit-Video, optionally guided by a reference image. Creates a new vid- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const {
        project_slug, prompt,
        video_slug, image_slug,
        aspect_ratio, resolution, duration, audio_setting,
        negative_prompt, enable_safety_checker, seed,
      } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const sourceVideoAssetId = video_slug.replace(/^@/, "");
      if (!sourceVideoAssetId.startsWith("vid-")) {
        return { isError: true as const, content: [{ type: "text" as const, text: `video_slug must be a vid-* asset, got: ${sourceVideoAssetId}` }] };
      }
      const manifest = await fs.getManifest(sourceVideoAssetId, project_slug);
      if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
      const sourceVideoFile = findVideoFile(manifest.value.files);
      if (!sourceVideoFile) return { isError: true as const, content: [{ type: "text" as const, text: `No video file found in asset ${sourceVideoAssetId}` }] };

      let refImage: ImageInput | undefined;
      let refImageAssetId: string | undefined;
      if (image_slug) {
        const resolved = await resolveImageSlugs(fs, [image_slug], project_slug);
        if (!resolved.ok) return { isError: true as const, content: [{ type: "text" as const, text: resolved.error }] };
        refImage = resolved.inputs[0];
        refImageAssetId = resolved.sourceImageIds[0];
      }

      const assetResult = await fs.createAsset("vid", `${modelSlug("kie", "wan/2-7-videoedit")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "wan/2-7-videoedit")}-edit-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_wan27_videoedit_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        sourceVideo: { assetId: sourceVideoAssetId, filename: sourceVideoFile.name },
        ...(refImage ? { refImage } : {}),
        sourceVideoIds: [sourceVideoAssetId],
        ...(refImageAssetId ? { sourceImageIds: [refImageAssetId] } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(audio_setting !== undefined ? { audio_setting } : {}),
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(enable_safety_checker !== undefined ? { enable_safety_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_video: sourceVideoAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
