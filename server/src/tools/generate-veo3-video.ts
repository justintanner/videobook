import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { VeoGenerateRequestSchema } from "@apicity/kie/zod";
import type { VeoModel } from "@apicity/kie";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { resolveImageSlug, slugify, type RefInput } from "./_seedance2-shared.js";

const veoInput = VeoGenerateRequestSchema.shape;

const veo3VideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(veoInput.prompt, "Video description", { required: true }),
  image_slugs: apicityStringArrayField(veoInput.imageUrls, "Reference image @slugs for image-to-video (optional)"),
  aspect_ratio: apicityField(veoInput.aspectRatio, "Output aspect ratio: 16:9 / 9:16 / Auto"),
  seed: apicityField(veoInput.seeds, "Random seed for reproducibility"),
} satisfies ZodRawShape;

type Veo3VideoArgs = SchemaArgs<typeof veo3VideoSchema>;

function makeVeo3VideoTool(
  toolName: string,
  model: VeoModel,
  label: string,
  description: string,
): (fs: VideocityFs) => ToolDef {
  return (fs: VideocityFs) => ({
    name: toolName,
    description,
    schema: veo3VideoSchema,
    handler: async (args) => {
      const raw = args as Veo3VideoArgs;
      const { project_slug, prompt, image_slugs, aspect_ratio, seed } = raw;

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

      const videoName = `${model}-${slugify(prompt) || Date.now().toString(36)}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const jobId = `${model}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_veo3_video",
        veoModel: model,
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        imageInputs,
        sourceImageIds,
        prompt,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(seed !== undefined ? { seed } : {}),
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
  });
}

export const generateVeo3VideoDef = makeVeo3VideoTool(
  "generate_veo3_video",
  "veo3",
  "Veo 3",
  "Generate a video using Google Veo 3 (KIE). Text-to-video or image-to-video from reference images. Creates a new vid- asset and enqueues a background job.",
);

export const generateVeo3FastVideoDef = makeVeo3VideoTool(
  "generate_veo3_fast_video",
  "veo3_fast",
  "Veo 3 Fast",
  "Generate a video using Google Veo 3 Fast (KIE). Text-to-video or image-to-video from reference images. Faster and cheaper than Veo 3. Creates a new vid- asset and enqueues a background job.",
);
