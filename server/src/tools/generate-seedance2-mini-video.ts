import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { Seedance2MiniInputSchema, Seedance2MiniRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { apicityField } from "./schema-from-apicity.js";
import {
  resolveAudioSlug,
  resolveImageSlug,
  resolveVideoSlug,
  slugify,
  type RefInput,
} from "./_seedance2-shared.js";

// modelSlug("kie", "bytedance/seedance-2-mini") would throw — @apicity/cost@0.6.0
// has no slug registered for the Seedance 2 Mini model yet, so asset/job names
// use this literal until the cost table catches up (see docs/apicity-gaps.md).
const SLUG = "seedance2mini";

const miniInput = Seedance2MiniInputSchema.shape;

// Seedance 2 Mini has no first/last frame and an optional prompt; it accepts a
// pure prompt and/or reference images, videos (≤3), and audio (≤3).
const generateSeedance2MiniVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().optional().describe("Video description (optional, max 20000 characters)"),
  image_slugs: z.array(z.string()).optional().describe("Reference image @slugs (e.g., @img-style)"),
  video_slugs: z.array(z.string()).optional().describe("Reference video @slugs (0-3, total ≤15s, e.g., @vid-motion)"),
  audio_slugs: z.array(z.string()).optional().describe("Reference audio @slugs (0-3, total ≤15s, e.g., @aud-music)"),
  aspect_ratio: apicityField(miniInput.aspect_ratio, "Output aspect ratio (adaptive auto-fits to content, default 16:9)"),
  resolution: apicityField(miniInput.resolution, "Output resolution: 480p / 720p (default 720p)"),
  duration: z.string().optional().describe("Video duration in seconds (4-15, default 15)"),
  generate_audio: z.boolean().optional().describe("Generate accompanying audio (default true)"),
  web_search: z.boolean().optional().describe("Use web search for grounding (default false)"),
  nsfw_checker: z.boolean().optional().describe("Content safety filter (default true)"),
  replace_audio_with: z.string().optional().describe("After generation, splice this audio over the seedance output (aud-* slug or `<assetId>/<filename>` form, e.g. `plan/s1.mp3`). Runs server-side as part of the generation pipeline so the asset only reaches 'ready' once the splice is in."),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedance2MiniVideoSchema>;

export function generateSeedance2MiniVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_seedance2_mini_video",
    description: "Generate a video using ByteDance Seedance 2 Mini (KIE). Supports a text prompt and/or reference images, videos, and audio (no first/last frame; up to 720p). Creates a new vid- asset and enqueues a background job.",
    schema: generateSeedance2MiniVideoSchema,
    handler: async (args) => {
      const raw = args as Args;
      const {
        project_slug, prompt,
        image_slugs, video_slugs, audio_slugs,
        aspect_ratio, resolution, duration,
        generate_audio, web_search, nsfw_checker,
      } = raw;
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";
      const replace_audio_with = blank(raw.replace_audio_with) ? undefined : raw.replace_audio_with;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const dropBlanks = (xs: string[] | undefined): string[] => (xs ?? []).filter((s) => !blank(s));
      const imgs = dropBlanks(image_slugs);
      const vids = dropBlanks(video_slugs);
      const auds = dropBlanks(audio_slugs);

      const apicityCheck = Seedance2MiniRequestSchema.safeParse({
        model: "bytedance/seedance-2-mini",
        input: {
          ...(prompt !== undefined ? { prompt } : {}),
          ...(imgs.length > 0 ? { reference_image_urls: imgs } : {}),
          ...(vids.length > 0 ? { reference_video_urls: vids } : {}),
          ...(auds.length > 0 ? { reference_audio_urls: auds } : {}),
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
          ...(duration !== undefined ? { duration: parseInt(duration, 10) } : {}),
          ...(generate_audio !== undefined ? { generate_audio } : {}),
          ...(web_search !== undefined ? { web_search } : {}),
          ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      const imageInputs: RefInput[] = [];
      for (const slug of imgs) {
        const r = await resolveImageSlug(fs, slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInputs.push(r.value);
      }

      const videoInputs: RefInput[] = [];
      for (const slug of vids) {
        const r = await resolveVideoSlug(fs, slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        videoInputs.push(r.value);
      }

      const audioInputs: RefInput[] = [];
      for (const slug of auds) {
        const r = await resolveAudioSlug(fs, slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        audioInputs.push(r.value);
      }

      let replaceAudioWith: RefInput | undefined;
      if (replace_audio_with !== undefined) {
        const r = await resolveAudioSlug(fs, replace_audio_with, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: `replace_audio_with: ${r.error}` }] };
        replaceAudioWith = r.value;
      }

      const videoName = `${SLUG}-${slugify(prompt ?? "") || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const sourceVideoIds = videoInputs.map((i) => i.assetId);
      const sourceAudioIds = audioInputs.map((i) => i.assetId);
      const jobId = `${SLUG}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_seedance2_mini_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        imageInputs,
        videoInputs,
        audioInputs,
        sourceImageIds,
        sourceVideoIds,
        sourceAudioIds,
        ...(prompt !== undefined ? { prompt } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(generate_audio !== undefined ? { generate_audio } : {}),
        ...(web_search !== undefined ? { web_search } : {}),
        ...(nsfw_checker !== undefined ? { nsfw_checker } : {}),
        ...(replaceAudioWith ? { replaceAudioWith } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            source_videos: sourceVideoIds,
            source_audios: sourceAudioIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
