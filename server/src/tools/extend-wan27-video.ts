import type { ClipfirstFs } from "clipfirst-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { Wan27ResolutionSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { findVideoFile } from "clipfirst-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 30)
    .replace(/-$/, "");
}

type RefInput = { assetId: string; filename: string };
type ResolveOk = { ok: true; value: RefInput };
type ResolveErr = { ok: false; error: string };

async function resolveVideoSlug(fs: ClipfirstFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  const assetId = raw.replace(/^@/, "");
  if (!assetId.startsWith("vid-")) return { ok: false, error: `video_slug must be a vid-* asset, got: ${assetId}` };
  const manifest = await fs.getManifest(assetId, projectSlug);
  if (!manifest.ok) return { ok: false, error: manifest.error.message };
  const file = findVideoFile(manifest.value.files);
  if (!file) return { ok: false, error: `No video file found in asset ${assetId}` };
  return { ok: true, value: { assetId, filename: file.name } };
}

const extendWan27VideoSchema = {
  project_slug: z.string().describe("Project slug"),
  video_slug: z.string().describe("Source video asset to extend (e.g., @vid-scene)"),
  prompt: z.string().describe("Video description (max 5000 chars)"),
  negative_prompt: z.string().optional().describe("Negative prompt — things to avoid (max 500 chars)"),
  resolution: z.enum(Wan27ResolutionSchema.options).optional().describe("Video resolution (default 1080p)"),
  duration: z.string().optional().describe("Video duration in seconds (2-15)"),
  prompt_extend: z.boolean().optional().describe("Intelligent prompt rewriting (default true)"),
  watermark: z.boolean().optional().describe("Add provider watermark to output (default false)"),
  nsfw_checker: z.boolean().optional().describe("Content safety filter (default false)"),
  seed: z.number().int().optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof extendWan27VideoSchema>;

export function extendWan27VideoDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "extend_wan27_video",
    description: "Extend an existing video asset using Wan 2.7 Image to Video by providing the source video as first_clip. Creates a new vid- asset and enqueues a background job.",
    schema: extendWan27VideoSchema,
    handler: async (args) => {
      const {
        project_slug, video_slug, prompt, negative_prompt,
        resolution, duration, prompt_extend, watermark, nsfw_checker, seed,
      } = args as Args;

      if (!process.env.KIE_API_KEY) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }],
        };
      }

      if (!video_slug) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "video_slug is required" }],
        };
      }

      const videoResult = await resolveVideoSlug(fs, video_slug, project_slug);
      if (!videoResult.ok) return { isError: true as const, content: [{ type: "text" as const, text: videoResult.error }] };
      const sourceVideo = videoResult.value;

      const videoName = `${modelSlug("kie", "wan/2-7-image-to-video")}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }],
        };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceVideoIds = [sourceVideo.assetId];
      const sourceImageIds: string[] = [];
      const sourceAudioIds: string[] = [];

      const jobId = `${modelSlug("kie", "wan/2-7-image-to-video")}-extend-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "extend_wan27_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        prompt,
        sourceVideo,
        sourceVideoIds,
        sourceImageIds,
        sourceAudioIds,
        ...(negative_prompt !== undefined ? { negative_prompt } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(prompt_extend !== undefined ? { prompt_extend } : {}),
        ...(watermark !== undefined ? { watermark } : {}),
        ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_videos: sourceVideoIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
