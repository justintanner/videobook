import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalXaiGrokImagineVideoEditVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";

const base = FalXaiGrokImagineVideoEditVideoRequestSchema.shape;

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: apicityStringField(base.prompt, "Edit instruction", { required: true }),
  video_slug: z.string().describe("Source video asset to edit (e.g., @vid-scene)"),
  resolution: apicityField(base.resolution, "Output resolution (auto / 480p / 720p)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateGrokImagineVideoEditFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_grok_imagine_video_edit_video",
    description: "Edit a video via fal.ai using xAI Grok Imagine Video edit-video. Creates a new vid- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, video_slug, resolution } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const sourceVideoAssetId = video_slug.replace(/^@/, "");
      if (!sourceVideoAssetId.startsWith("vid-")) {
        return { isError: true as const, content: [{ type: "text" as const, text: `video_slug must be a vid-* asset, got: ${sourceVideoAssetId}` }] };
      }
      const manifest = await fs.files.manifest(sourceVideoAssetId, project_slug);
      if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
      const sourceVideoFile = findVideoFile(manifest.value.files);
      if (!sourceVideoFile) return { isError: true as const, content: [{ type: "text" as const, text: `No video file found in asset ${sourceVideoAssetId}` }] };

      const assetResult = await fs.artifacts.create("vid", `${modelSlug("kie", "grok-imagine/text-to-video")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { slug: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "grok-imagine/text-to-video")}-edit-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_video_edit_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        sourceVideo: { assetId: sourceVideoAssetId, filename: sourceVideoFile.name },
        sourceVideoIds: [sourceVideoAssetId],
        ...(resolution !== undefined ? { resolution } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_video: sourceVideoAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
