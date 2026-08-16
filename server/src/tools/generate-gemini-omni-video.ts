import type { Engine } from "videobook-engine";
import { modelSlug } from "@apicity/cost";
import { z, type ZodRawShape } from "zod";
import { GeminiOmniVideoRequestSchema } from "@apicity/kie/zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { zodErrorToToolResult } from "./_shared.js";
import { apicityField, apicityStringArrayField, apicityStringField } from "./schema-from-apicity.js";
import { resolveImageRef, resolveVideoRef, type RefInput } from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

const SLUG = modelSlug("kie", "gemini-omni-video");

const omniInput = GeminiOmniVideoRequestSchema.shape.input.shape;

const generateGeminiOmniVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: apicityStringField(omniInput.prompt, "Multimodal video generation prompt (max 20000 characters)", { required: true }),
  image_refs: apicityStringArrayField(omniInput.image_urls, "Reference image artifact ids (0-7, each ≤20MB)"),
  video_ref: z.string().optional().describe("Reference video clip artifact id (one clip)"),
  video_clip_start: z.number().min(0).optional().describe("Reference clip start time in seconds (requires video_ref)"),
  video_clip_ends: z.number().min(0).optional().describe("Reference clip end time in seconds; must be > start and < start+10s (requires video_ref)"),
  duration: apicityField(omniInput.duration, "Output duration in seconds: 4 / 6 / 8 / 10 (ignored when a reference video clip is supplied)", { required: true }),
  aspect_ratio: apicityField(omniInput.aspect_ratio, "Output aspect ratio: 16:9 / 9:16"),
  resolution: apicityField(omniInput.resolution, "Output resolution: 720p / 1080p / 4k (default 720p)"),
  seed: apicityField(omniInput.seed, "Random seed (0-2147483647)"),
  _provider: z.string().optional().describe("Provider key (e.g., 'kie')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGeminiOmniVideoSchema>;

export function generateGeminiOmniVideoDef(fs: Engine): ToolDef {
  return {
    name: "generate_kie_gemini_omni_video",
    description: "Generate a video using Google Gemini Omni (KIE). Multimodal: a text prompt plus optional reference images (0-7) and one reference video clip with in/out timecodes. Creates a new video artifact and enqueues a background job.",
    schema: generateGeminiOmniVideoSchema,
    handler: async (args) => {
      const raw = args as Args;
      const {
        book_id, prompt,
        image_refs, video_ref,
        video_clip_start, video_clip_ends,
        duration, aspect_ratio, resolution, seed,
      } = raw;
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";

      if (!process.env.KIE_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "KIE_API_KEY environment variable is not set" }] };
      }

      const imgs = (image_refs ?? []).filter((s) => !blank(s));
      const videoRef = blank(video_ref) ? undefined : video_ref;

      const apicityCheck = GeminiOmniVideoRequestSchema.safeParse({
        model: "gemini-omni-video",
        input: {
          prompt,
          duration,
          ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
          ...(seed !== undefined ? { seed } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
        },
      });
      if (!apicityCheck.success) return zodErrorToToolResult(apicityCheck.error);

      // Fast pre-check of the clip timing that kie's validateGeminiOmniVideoRequest
      // enforces server-side (ends > start AND ends < start + 10s), so users get a
      // friendly message instead of a provider 400.
      if (videoRef !== undefined) {
        const start = video_clip_start ?? 0;
        const ends = video_clip_ends ?? 0;
        if (!(ends > start) || ends - start >= 10) {
          return { isError: true as const, content: [{ type: "text" as const, text: "video_clip_ends must be greater than video_clip_start and less than 10 seconds after it" }] };
        }
      }

      const imageInputs: RefInput[] = [];
      for (const slug of imgs) {
        const r = await resolveImageRef(fs, slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInputs.push(r.value);
      }

      let videoInput: RefInput | undefined;
      if (videoRef !== undefined) {
        const r = await resolveVideoRef(fs, videoRef);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        videoInput = r.value;
      }

      const videoName = generationLabel(SLUG, prompt);
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const sourceVideoIds = videoInput ? [videoInput.assetId] : [];
      const jobId = `${SLUG}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_gemini_omni_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        imageInputs,
        ...(videoInput ? { videoInput } : {}),
        sourceImageIds,
        sourceVideoIds,
        prompt,
        duration,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(resolution !== undefined ? { resolution } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(video_clip_start !== undefined ? { video_clip_start } : {}),
        ...(video_clip_ends !== undefined ? { video_clip_ends } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            source_videos: sourceVideoIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
