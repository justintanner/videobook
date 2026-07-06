import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { KlingV3TurboResolutionSchema, KlingV3TurboAspectRatioSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField } from "./schema-from-apicity.js";
import { resolveImageSlug, slugify, type RefInput } from "./_seedance2-shared.js";
import { modelSlug } from "@apicity/cost";

const generateKling30TurboVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description"),
  image_slugs: z.array(z.string()).optional().describe("0-1 reference image @slugs (optional)"),
  duration: z.string().optional().describe("Video duration: 3s-15s (default '5')"),
  resolution: apicityField(KlingV3TurboResolutionSchema, "Video resolution: 720p / 1080p"),
  aspect_ratio: apicityField(KlingV3TurboAspectRatioSchema, "Video aspect ratio (only for text-to-video)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateKling30TurboVideoSchema>;

export function generateKling30TurboVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_kling30_turbo_video",
    description: "Generate a video using Kling 3.0 Turbo tier via KIE (text-to-video or image-to-video). Creates a new vid- asset and enqueues a background job.",
    schema: generateKling30TurboVideoSchema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, duration, resolution, aspect_ratio } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";
      const dropBlanks = (xs: string[] | undefined): string[] => (xs ?? []).filter((s) => !blank(s));
      const imgs = dropBlanks(image_slugs);

      const imageInputs: RefInput[] = [];
      for (const slug of imgs) {
        const r = await resolveImageSlug(fs, slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: `image_slugs: ${r.error}` }] };
        imageInputs.push(r.value);
      }

      const isI2V = imageInputs.length > 0;
      const model = isI2V ? "kling/v3-turbo-image-to-video" : "kling/v3-turbo-text-to-video";

      const videoName = `${modelSlug("kie", model)}-${slugify(prompt) || Date.now().toString(36)}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const jobId = `kie-${modelSlug("kie", model)}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_kling30_turbo_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        imageInputs,
        sourceImageIds,
        prompt,
        model,
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(!isI2V && aspect_ratio !== undefined ? { aspect_ratio } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
