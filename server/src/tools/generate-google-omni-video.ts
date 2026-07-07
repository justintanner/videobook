import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlug, resolveVideoSlug, slugify, type RefInput } from "./_seedance2-shared.js";

// Literal slug — @apicity/cost has no google provider pricing, so modelSlug()
// would throw (docs/apicity-gaps.md §15).
const SLUG = "google-omni";

// Omni Flash V2V edit accepts at most 5 reference images alongside the clip
// (R2V without a clip allows 7). Enums are hand-typed from the useapi.net
// docs — @apicity/googleflow's flow schemas carry no enums (docs/apicity-gaps.md
// §14) — and mirror the kie gemini-omni tool's values so provider switching
// keeps prefilled params valid.
const OMNI_V2V_MAX_IMAGES = 5;
const GOOGLE_OMNI_DURATIONS = ["4", "6", "8", "10"] as const;
const GOOGLE_OMNI_ASPECT_RATIOS = ["16:9", "9:16"] as const;

// Gemini Omni ("Omni Flash") on Google Flow: multimodal text/image/clip-to-
// video, the direct-Google alternative to the kie-proxied
// generate_gemini_omni_video. Voice/character references exist upstream but
// need Google Flow account-level create flows videocity does not wire.
const generateGoogleOmniVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().max(20000).describe("Multimodal video generation prompt (max 20000 characters)"),
  first_frame_slug: z.string().optional().describe("First-frame image asset for image-to-video (e.g., @img-start); not combinable with image_slugs or video_slug"),
  image_slugs: z.array(z.string()).max(7).optional().describe("Reference image @slugs (0-7, or 0-5 with a reference clip, e.g., @img-style); not combinable with first_frame_slug"),
  video_slug: z.string().optional().describe("Reference video clip @slug for video editing (one clip, e.g., @vid-motion); not combinable with first_frame_slug"),
  video_clip_start: z.number().min(0).max(10).optional().describe("Reference clip start time in seconds on a 10s timeline (requires video_slug)"),
  video_clip_ends: z.number().min(0).max(10).optional().describe("Reference clip end time in seconds on a 10s timeline; must be > start (requires video_slug)"),
  duration: z.enum(GOOGLE_OMNI_DURATIONS).optional().describe("Output duration in seconds: 4 / 6 / 8 / 10 (ignored when a reference video clip is supplied; default 8)"),
  aspect_ratio: z.enum(GOOGLE_OMNI_ASPECT_RATIOS).optional().describe("Output aspect ratio: 16:9 / 9:16"),
  seed: z.number().int().min(0).optional().describe("Random seed for reproducibility"),
  _provider: z.string().optional().describe("Provider key (e.g., 'google')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGoogleOmniVideoSchema>;

export function generateGoogleOmniVideoDef(fs: VideocityFs): ToolDef {
  return {
    name: "generate_google_omni_video",
    description: "Generate a video using Google Gemini Omni via Google Flow. Multimodal: a text prompt plus optional first frame, reference images (0-7), or one reference video clip with in/out timecodes. Creates a new vid- asset and enqueues a background job.",
    schema: generateGoogleOmniVideoSchema,
    handler: async (args) => {
      const raw = args as Args;
      const {
        project_slug, prompt,
        first_frame_slug, image_slugs, video_slug,
        video_clip_start, video_clip_ends,
        duration, aspect_ratio, seed,
      } = raw;
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";

      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "GOOGLE_FLOW_API_KEY environment variable is not set" }] };
      }

      const imgs = (image_slugs ?? []).filter((s) => !blank(s));
      const videoSlug = blank(video_slug) ? undefined : video_slug;
      const firstFrameSlug = blank(first_frame_slug) ? undefined : first_frame_slug;

      // Omni Flash modes are mutually exclusive: startImage I2V
      // (first_frame_slug) cannot combine with referenceImage_* (image_slugs)
      // or referenceVideo_1 V2V (video_slug).
      if (firstFrameSlug !== undefined) {
        if (imgs.length > 0) {
          return { isError: true as const, content: [{ type: "text" as const, text: "first_frame_slug cannot be combined with image_slugs — Omni Flash start-image I2V does not accept reference images" }] };
        }
        if (videoSlug !== undefined) {
          return { isError: true as const, content: [{ type: "text" as const, text: "first_frame_slug cannot be combined with video_slug — Omni Flash start-image I2V and reference-video V2V are mutually exclusive" }] };
        }
      }

      // Clip-timing pre-check mirroring the kie gemini-omni tool. Omni Flash
      // trims on a 24fps / 240-frame timeline, so the window may span up to
      // but not exceed exactly 10 seconds.
      if (videoSlug !== undefined) {
        const start = video_clip_start ?? 0;
        const ends = video_clip_ends;
        if (video_clip_start !== undefined && video_clip_start >= 10) {
          return { isError: true as const, content: [{ type: "text" as const, text: "video_clip_start must be less than 10 seconds" }] };
        }
        if (ends !== undefined && (!(ends > start) || ends > 10)) {
          return { isError: true as const, content: [{ type: "text" as const, text: "video_clip_ends must be greater than video_clip_start and at most 10 seconds" }] };
        }
        if (imgs.length > OMNI_V2V_MAX_IMAGES) {
          return { isError: true as const, content: [{ type: "text" as const, text: `Omni Flash video edit supports at most ${OMNI_V2V_MAX_IMAGES} reference images alongside the clip (got ${imgs.length})` }] };
        }
      }

      const imageInputs: RefInput[] = [];
      for (const slug of imgs) {
        const r = await resolveImageSlug(fs, slug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInputs.push(r.value);
      }

      let firstFrame: RefInput | undefined;
      if (firstFrameSlug !== undefined) {
        const r = await resolveImageSlug(fs, firstFrameSlug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstFrame = r.value;
      }

      let videoInput: RefInput | undefined;
      if (videoSlug !== undefined) {
        const r = await resolveVideoSlug(fs, videoSlug, project_slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        videoInput = r.value;
      }

      const videoName = `${SLUG}-${slugify(prompt) || String(Date.now())}`;
      const assetResult = await fs.createAsset("vid", videoName, project_slug);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { assetId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const sourceVideoIds = videoInput ? [videoInput.assetId] : [];
      const sourceFirstFrameId = firstFrame ? firstFrame.assetId : undefined;
      const jobId = `${SLUG}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_google_omni_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        ...(firstFrame ? { firstFrame } : {}),
        imageInputs,
        ...(videoInput ? { videoInput } : {}),
        sourceImageIds,
        sourceVideoIds,
        prompt,
        ...(duration !== undefined ? { duration } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(video_clip_start !== undefined ? { video_clip_start } : {}),
        ...(video_clip_ends !== undefined ? { video_clip_ends } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_first_frame: sourceFirstFrameId ?? null,
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
