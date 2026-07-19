import { modelSlug } from "@apicity/cost";
import type { VideocityFs, AssetManifestFile } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { GrokImageToVideoRequestSchema } from "@apicity/kie/zod";
import { extname } from "node:path";
import { queue } from "../queue.js";
import { enumOptions } from "../zod-slots.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { requireAtLeastOne, toolError } from "./_shared.js";
import { resolveAudioSlug, type RefInput } from "./_seedance2-shared.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

const IMAGE_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp", "gif"]);

function findImageFile(files: AssetManifestFile[]): AssetManifestFile | null {
  const images = files.filter((f) => {
    const ext = (f.extension ?? extname(f.name)).replace(/^\./, "").toLowerCase();
    return IMAGE_EXTENSIONS.has(ext);
  });
  return images.find((f) => f.name.startsWith("original")) ?? images[0] ?? null;
}

function deriveVideoName(firstAssetId: string): string {
  const baseName = firstAssetId.startsWith("img-") ? firstAssetId.slice(4) : firstAssetId;
  return `grok-${baseName}`;
}

// Apicity's mode enum includes "spicy", which this i2v endpoint rejects (docs/apicity-gaps.md).
const grokI2v = GrokImageToVideoRequestSchema.shape.input.shape;
const GROK_IMAGE_TO_VIDEO_MODES = enumOptions(grokI2v.mode).filter((mode) => mode !== "spicy") as [string, ...string[]];

const generateGrokImagineVideoSchema = {
  image_slugs: apicityStringArrayField(grokI2v.image_urls, "1-7 reference image asset slugs (e.g., ['@img-sunset'])"),
  asset_id: z.string().optional().describe("Single image asset ID (must be img-*); back-compat alias for image_slugs[0]"),
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(grokI2v.prompt, "Optional prompt to guide video generation (max 4096 chars)"),
  mode: z.enum(GROK_IMAGE_TO_VIDEO_MODES).optional().describe("Generation mode: fun / normal"),
  duration: apicityField(grokI2v.duration, "Video duration in seconds (6-30)"),
  resolution: apicityField(grokI2v.resolution, "Output resolution"),
  aspect_ratio: apicityField(grokI2v.aspect_ratio, "Output aspect ratio"),
  nsfw_checker: apicityField(grokI2v.nsfw_checker, "Enable NSFW content safety filter (default false)"),
  replace_audio_with: z.string().optional().describe("After generation, splice this audio over the Grok output (aud-* slug or `<assetId>/<filename>` form, e.g. `plan/s1.mp3`). Runs server-side so the asset only reaches ready once the splice is in."),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie', 'xai')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGrokImagineVideoSchema>;

export function generateGrokImagineVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_grok_imagine_video",
    description: "Generate a video from image asset(s) using Kie Grok Imagine Video 1.5. Creates a new vid- asset and enqueues a background job. Requires at least one of image_slugs or asset_id.",
    schema: generateGrokImagineVideoSchema,
    handler: async (args) => {
      const { asset_id: rawAssetId, image_slugs, project_slug, prompt, mode, duration, resolution, aspect_ratio, nsfw_checker, replace_audio_with, _provider } = args as Args;

      const isXai = _provider !== undefined && _provider.startsWith("xai");
      const requiredKey = isXai ? "XAI_API_KEY" : "KIE_API_KEY";
      if (!process.env[requiredKey]) {
        return toolError(`${requiredKey} environment variable is not set`);
      }

      const missingInput = requireAtLeastOne("generate_grok_imagine_video", [
        { name: "image_slugs", value: image_slugs },
        { name: "asset_id", value: rawAssetId },
      ]);
      if (missingInput) return missingInput;

      // Normalize asset_id back-compat into image_slugs. The schema caps
      // image_slugs at 7, so the resolved list can never exceed 7 here.
      const slugs = (image_slugs && image_slugs.length > 0)
        ? image_slugs.map((s) => s.replace(/^@/, ""))
        : (rawAssetId ? [rawAssetId.replace(/^@/, "")] : []);

      const assetIds: string[] = [];
      const imageFilenames: string[] = [];
      for (const assetId of slugs) {
        if (!assetId.startsWith("img-")) {
          return toolError(`image asset must start with img-, got: ${assetId}`);
        }

        const manifestResult = await fs.getManifest(assetId, project_slug);
        if (!manifestResult.ok) {
          return toolError(manifestResult.error.message);
        }

        const imageFile = findImageFile(manifestResult.value.files);
        if (!imageFile) {
          return toolError(`No image file found in asset ${assetId}`);
        }
        assetIds.push(assetId);
        imageFilenames.push(imageFile.name);
      }

      let replaceAudioWith: RefInput | undefined;
      if (replace_audio_with !== undefined && replace_audio_with.trim().length > 0) {
        const resolvedAudio = await resolveAudioSlug(fs, replace_audio_with, project_slug);
        if (!resolvedAudio.ok) {
          return toolError(resolvedAudio.error);
        }
        replaceAudioWith = resolvedAudio.value;
      }

      const videoName = deriveVideoName(assetIds[0]);
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return toolError(`Failed to create video asset: ${assetResult.error.message}`);
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `${modelSlug("kie", "grok-imagine/image-to-video")}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_video",
        sourceImageIds: assetIds,
        imageFilenames,
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(mode !== undefined ? { mode } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        ...(replaceAudioWith !== undefined ? { replaceAudioWith } : {}),
        ...(_provider !== undefined ? { _provider } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: assetIds,
            ...(replaceAudioWith ? { replace_audio_with: replaceAudioWith.assetId } : {}),
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
