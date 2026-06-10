import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import { findVideoFile } from "videocity-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { slugify } from "./_fal-shared.js";
import { modelSlug } from "@apicity/cost";

const schema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().describe("Video description"),
  video_slug: z.string().describe("Source video asset to extend (e.g., @vid-scene)"),
  duration: z.number().int().min(2).max(10).optional().describe("Extension duration in seconds (2-10)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateGrokImagineVideoExtendFalDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_grok_imagine_video_extend_fal",
    description: "Extend a video via fal.ai using xAI Grok Imagine Video extend-video. Creates a new vid- asset and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { project_slug, prompt, video_slug, duration } = args as Args;

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

      const assetResult = await fs.createAsset("vid", `${modelSlug("kie", "grok-imagine/extend")}-${slugify(prompt) || String(Date.now())}`, project_slug);
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "grok-imagine/extend")}-extend-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_video_extend_fal",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        sourceVideo: { assetId: sourceVideoAssetId, filename: sourceVideoFile.name },
        sourceVideoIds: [sourceVideoAssetId],
        ...(duration !== undefined ? { duration } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_video: sourceVideoAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
