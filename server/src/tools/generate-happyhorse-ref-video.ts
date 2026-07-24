import type { Engine, ArtifactManifestFile } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import {
  HappyHorse11AspectRatioSchema,
  HappyHorse11ReferenceToVideoRequestSchema,
  HappyHorseDurationSchema,
  HappyHorseResolutionSchema,
} from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringArrayField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";

const SLUG = modelSlug("kie", "happyhorse-1-1/reference-to-video");

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: ArtifactManifestFile[]): ArtifactManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

type RefInput = { assetId: string; filename: string };

const generateHappyhorseRefVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.prompt, "Video description (max 5000 chars / 2500 Chinese chars)", { required: true }),
  image_slugs: apicityStringArrayField(HappyHorse11ReferenceToVideoRequestSchema.shape.input.shape.reference_image, "1-9 reference image @slugs (order defines character1, character2, ...)", { required: true }),
  resolution: apicityField(HappyHorseResolutionSchema, "Output resolution: 720p / 1080p (default 1080p)"),
  aspect_ratio: apicityField(HappyHorse11AspectRatioSchema, "Output aspect ratio (default 16:9)"),
  duration: apicityStringNumberField(HappyHorseDurationSchema, "Video duration in seconds (3-15, default 5)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateHappyhorseRefVideoSchema>;

export function generateHappyhorseRefVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_happyhorse_1_1_reference_to_video",
    description: "Generate a multi-character video using HappyHorse reference-to-video (1-9 reference images, order defines character1/character2/...). Creates a new vid- asset and enqueues a background job.",
    schema: generateHappyhorseRefVideoSchema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, resolution, aspect_ratio, duration } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const imageInputs: RefInput[] = [];
      for (const raw of image_slugs) {
        const assetId = raw.replace(/^@/, "");
        if (!assetId.startsWith("img-")) {
          return { isError: true as const, content: [{ type: "text" as const, text: `image_slugs entries must be img-* assets, got: ${assetId}` }] };
        }
        const manifest = await fs.files.manifest(assetId, project_slug);
        if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
        const file = findImageFile(manifest.value.files);
        if (!file) return { isError: true as const, content: [{ type: "text" as const, text: `No image file found in asset ${assetId}` }] };
        imageInputs.push({ assetId, filename: file.name });
      }

      const videoName = `${SLUG}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.artifacts.create("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { slug: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const jobId = `${SLUG}-r2v-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_happyhorse_ref_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        imageInputs,
        sourceImageIds,
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ vid_asset_id: vidAssetId, source_images: sourceImageIds, job_id: jobId, status: "enqueued" }),
        }],
      };
    },
  };
}
