import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { FalXaiGrokImagineVideoEditVideoRequestSchema } from "@apicity/fal/zod";
import { queue } from "../queue.js";
import { findVideoFile } from "videobook-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { modelSlug } from "@apicity/cost";
import { apicityField, apicityStringField } from "./schema-from-apicity.js";
import { generationLabel } from "../artifact-label.js";

const base = FalXaiGrokImagineVideoEditVideoRequestSchema.shape;

const schema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(base.prompt, "Edit instruction", { required: true }),
  video_ref: z.string().describe("Source video artifact id to edit"),
  resolution: apicityField(base.resolution, "Output resolution (auto / 480p / 720p)"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof schema>;

export function generateGrokImagineVideoEditFalDef(fs: Engine): ToolDef {
  return {
    name: "generate_fal_grok_imagine_video_edit_video",
    description: "Edit a video via fal.ai using xAI Grok Imagine Video edit-video. Creates a new video artifact and enqueues a background job.",
    schema,
    handler: async (args) => {
      const { book_id, prompt, video_ref, resolution } = args as Args;

      if (!process.env.FAL_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "FAL_API_KEY environment variable is not set" }] };
      }

      const sourceVideoAssetId = video_ref.replace(/^@/, "");
      const sourceVideoArtifact = fs.artifacts.get(sourceVideoAssetId);
      if (!sourceVideoArtifact.ok) return { isError: true as const, content: [{ type: "text" as const, text: sourceVideoArtifact.error.message }] };
      if (sourceVideoArtifact.value.kind !== "video") {
        return { isError: true as const, content: [{ type: "text" as const, text: `video_ref must be a video artifact, got ${sourceVideoArtifact.value.kind}: ${sourceVideoAssetId}` }] };
      }
      const manifest = await fs.files.manifest(sourceVideoAssetId);
      if (!manifest.ok) return { isError: true as const, content: [{ type: "text" as const, text: manifest.error.message }] };
      const sourceVideoFile = findVideoFile(manifest.value.files);
      if (!sourceVideoFile) return { isError: true as const, content: [{ type: "text" as const, text: `No video file found in asset ${sourceVideoAssetId}` }] };

      const assetResult = await fs.artifacts.create("vid", generationLabel(modelSlug("kie", "grok-imagine/text-to-video"), prompt));
      if (!assetResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;

      const jobId = `fal-${modelSlug("kie", "grok-imagine/text-to-video")}-edit-${vidAssetId}-${Date.now()}`;
      await queue.enqueue(jobId, {
        type: "generate_grok_imagine_video_edit_fal",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        prompt,
        sourceVideo: { assetId: sourceVideoAssetId, filename: sourceVideoFile.name },
        sourceVideoIds: [sourceVideoAssetId],
        ...(resolution !== undefined ? { resolution } : {}),
      } as unknown as Record<string, unknown>);

      return { content: [{ type: "text" as const, text: JSON.stringify({ vid_asset_id: vidAssetId, source_video: sourceVideoAssetId, job_id: jobId, status: "enqueued" }) }] };
    },
  };
}
