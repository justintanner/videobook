import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { Seedance2MiniInputSchema, Seedance2MiniRequestSchema } from "@apicity/kie/zod";
import { modelSlug } from "@apicity/cost";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import {
  apicityField,
  apicityStringArrayField,
  apicityStringField,
  apicityStringNumberField,
} from "./schema-from-apicity.js";
import {
  resolveAudioRef,
  resolveImageRef,
  resolveVideoRef,
  type RefInput,
} from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

// @apicity/cost@0.6.1 registers the Seedance 2 Mini slug ("sd2m"), matching the
// sibling fast/regular tools' modelSlug-based naming.
const SLUG = modelSlug("kie", "bytedance/seedance-2-mini");

const miniInput = Seedance2MiniInputSchema.shape;

// Seedance 2 Mini has no first/last frame and an optional prompt; it accepts a
// pure prompt and/or reference images, videos (≤3), and audio (≤3).
const generateSeedance2MiniVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(miniInput.prompt, "Video description (optional, max 20000 characters)"),
  image_refs: apicityStringArrayField(miniInput.reference_image_urls, "Reference image artifact ids"),
  video_refs: apicityStringArrayField(miniInput.reference_video_urls, "Reference video artifact ids (0-3, total ≤15s)"),
  audio_refs: apicityStringArrayField(miniInput.reference_audio_urls, "Reference audio artifact ids (0-3, total ≤15s)"),
  aspect_ratio: apicityField(miniInput.aspect_ratio, "Output aspect ratio (adaptive auto-fits to content, default 16:9)"),
  resolution: apicityField(miniInput.resolution, "Output resolution: 480p / 720p (default 720p)"),
  duration: apicityStringNumberField(miniInput.duration, "Video duration in seconds (4-15, default 15)"),
  generate_audio: apicityField(miniInput.generate_audio, "Generate accompanying audio (default true)"),
  web_search: apicityField(miniInput.web_search, "Use web search for grounding (default false)"),
  nsfw_checker: apicityField(miniInput.nsfw_checker, "Content safety filter (default true)"),
  replace_audio_with: z.string().optional().describe("After generation, splice an aud-* artifact over the Seedance output. Runs server-side as part of the generation pipeline so the asset only reaches 'ready' once the splice is in."),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateSeedance2MiniVideoSchema>;

export function generateSeedance2MiniVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_seedance_2_0_mini_video",
    description: "Generate a video using ByteDance Seedance 2 Mini (KIE). Supports a text prompt and/or reference images, videos, and audio (no first/last frame; up to 720p). Creates a new video artifact and enqueues a background job.",
    schema: generateSeedance2MiniVideoSchema,
    handler: async (args) => {
      const raw = args as Args;
      const {
        book_id, prompt,
        image_refs, video_refs, audio_refs,
        aspect_ratio, resolution, duration,
        generate_audio, web_search, nsfw_checker,
      } = raw;
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";
      const replace_audio_with = blank(raw.replace_audio_with) ? undefined : raw.replace_audio_with;

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const dropBlanks = (xs: string[] | undefined): string[] => (xs ?? []).filter((s) => !blank(s));
      const imgs = dropBlanks(image_refs);
      const vids = dropBlanks(video_refs);
      const auds = dropBlanks(audio_refs);

      const apicityCheck = Seedance2MiniRequestSchema.safeParse({
        model: "bytedance/seedance-2-mini",
        input: {
          ...(prompt !== undefined ? { prompt } : {}),
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
        const r = await resolveImageRef(fs, slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInputs.push(r.value);
      }

      const videoInputs: RefInput[] = [];
      for (const slug of vids) {
        const r = await resolveVideoRef(fs, slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        videoInputs.push(r.value);
      }

      const audioInputs: RefInput[] = [];
      for (const slug of auds) {
        const r = await resolveAudioRef(fs, slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        audioInputs.push(r.value);
      }

      let replaceAudioWith: RefInput | undefined;
      if (replace_audio_with !== undefined) {
        const r = await resolveAudioRef(fs, replace_audio_with);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: `replace_audio_with: ${r.error}` }] };
        replaceAudioWith = r.value;
      }

      const videoName = generationLabel(SLUG, prompt);
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const sourceVideoIds = videoInputs.map((i) => i.assetId);
      const sourceAudioIds = audioInputs.map((i) => i.assetId);
      const jobId = `${SLUG}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_seedance2_mini_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
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
