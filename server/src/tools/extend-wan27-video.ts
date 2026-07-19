import type { VideocityFs } from "videocity-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { Wan27ImageToVideoRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import { findVideoFile } from "videocity-engine";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { apicityField, apicityStringField, apicityStringNumberField } from "./schema-from-apicity.js";

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
const wan27I2v = Wan27ImageToVideoRequestSchema.shape.input.shape;

async function resolveVideoSlug(fs: VideocityFs, raw: string, projectSlug: string): Promise<ResolveOk | ResolveErr> {
  // `@<assetId>/<filename>` form: address a specific sibling file inside an
  // asset (e.g. `@plan/s1.mp4`). Bypasses the vid- prefix gate.
  const stripped = raw.replace(/^@/, "");
  const slashIdx = stripped.indexOf("/");
  if (slashIdx >= 0) {
    const assetId = stripped.slice(0, slashIdx);
    const filename = stripped.slice(slashIdx + 1);
    if (!assetId || !filename) return { ok: false, error: `Invalid slashed slug: ${raw}` };
    const manifest = await fs.getManifest(assetId, projectSlug, { includeDotfiles: true });
    if (!manifest.ok) return { ok: false, error: manifest.error.message };
    const file = manifest.value.files.find((f) => f.name === filename);
    if (!file) return { ok: false, error: `File ${filename} not found in asset ${assetId}` };
    return { ok: true, value: { assetId, filename } };
  }
  const assetId = stripped;
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
  prompt: apicityStringField(wan27I2v.prompt, "Video description (max 5000 chars)", { required: true }),
  negative_prompt: apicityStringField(wan27I2v.negative_prompt, "Negative prompt — things to avoid (max 500 chars)"),
  resolution: apicityField(wan27I2v.resolution, "Video resolution (default 1080p)"),
  duration: apicityStringNumberField(wan27I2v.duration, "Video duration in seconds (2-15)"),
  prompt_extend: apicityField(wan27I2v.prompt_extend, "Intelligent prompt rewriting (default true)"),
  watermark: apicityField(wan27I2v.watermark, "Add provider watermark to output (default false)"),
  nsfw_checker: apicityField(wan27I2v.nsfw_checker, "Content safety filter (default false)"),
  seed: apicityField(wan27I2v.seed, "Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof extendWan27VideoSchema>;

export function extendWan27VideoDef(fs: VideocityFs): ToolDef {
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
