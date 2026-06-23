import type { VideocityFs, AssetManifestFile } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { HappyHorseAspectRatioSchema, HappyHorseResolutionSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField } from "./schema-from-apicity.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
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
  prompt: z.string().describe("Video description (max 5000 chars / 2500 Chinese chars)"),
  image_slugs: z.array(z.string()).min(1).max(9).describe("1-9 reference image @slugs (order defines character1, character2, ...)"),
  resolution: apicityField(HappyHorseResolutionSchema, "Output resolution: 720p / 1080p (default 1080p)"),
  aspect_ratio: apicityField(HappyHorseAspectRatioSchema, "Output aspect ratio (default 16:9)"),
  duration: z.string().optional().describe("Video duration in seconds (3-15, default 5)"),
  seed: z.number().int().optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateHappyhorseRefVideoSchema>;

export function generateHappyhorseRefVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_happyhorse_ref_video",
    description: "Generate a multi-character video using HappyHorse reference-to-video (1-9 reference images, order defines character1/character2/...). Creates a new vid- asset and enqueues a background job.",
    schema: generateHappyhorseRefVideoSchema,
    handler: async (args) => {
      const { project_slug, prompt, image_slugs, resolution, aspect_ratio, duration, seed } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const imageInputs: RefInput[] = [];
      for (const raw of image_slugs) {
        const assetId = raw.replace(/^@/, "");
        if (!assetId.startsWith("img-") && !assetId.startsWith("char-")) {
          return { isError: true as const, content: [{ type: "text" as const, text: `image_slugs entries must be img-* or char-* assets, got: ${assetId}` }] };
        }
        const manifest = await fs.getManifest(assetId, project_slug);
        if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
        const file = findImageFile(manifest.value.files);
        if (!file) return { isError: true as const, content: [{ type: "text" as const, text: `No image file found in asset ${assetId}` }] };
        imageInputs.push({ assetId, filename: file.name });
      }

      const videoName = `${modelSlug("kie", "happyhorse/reference-to-video")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const jobId = `${modelSlug("kie", "happyhorse/reference-to-video")}-r2v-${vidAssetId}-${Date.now()}`;

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
        ...(seed !== undefined ? { seed } : {}),
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
