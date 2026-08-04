import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import type { GoogleVeo31Model } from "../payload-builders.js";
import { queue } from "../queue.js";
import { rewriteImageRefMentions, stripRefMentions } from "../google-flow-refs.js";
import type { ToolDef } from "./tool-def.js";
import { resolveImageRef, slugify, type RefInput } from "./_seedance2-shared.js";

// Allowed values are hand-typed from the useapi.net Google Flow docs — the
// 0.7.3 @apicity/googleflow schemas carry only loose `.or(z.string())`
// model/aspect enums, not the per-model restrictions (docs/apicity-gaps.md §14).
const VEO31_ASPECT_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4"] as const;
const VEO31_DURATIONS = ["4", "6", "8"] as const;

// Literal job-name strings: @apicity/cost has no google provider, so
// modelSlug() would throw (docs/apicity-gaps.md §15).
const VEO31_SLUGS: Record<GoogleVeo31Model, string> = {
  "veo-3.1-quality": "veo31",
  "veo-3.1-fast": "veo31-fast",
  "veo-3.1-lite": "veo31-lite",
  "veo-3.1-lite-low-priority": "veo31-lite-lp",
};

function buildVeo31Schema(allowRefs: boolean) {
  return {
    book_id: z.string().describe("Book id"),
    prompt: z.string().describe("Video description"),
    first_frame_ref: z.string().optional().describe("Start frame image artifact id for image-to-video"),
    last_frame_ref: z.string().optional().describe("End frame image artifact id; requires first_frame_ref"),
    ...(allowRefs
      ? {
          image_refs: z.array(z.string()).max(3).optional().describe("Reference image artifact ids (0-3; not combinable with first/last frame)"),
          duration: z.enum(VEO31_DURATIONS).optional().describe("Video duration in seconds (default 8; 4/6 require an Ultra plan)"),
        }
      : {}),
    aspect_ratio: z.enum(VEO31_ASPECT_RATIOS).optional().describe("Output aspect ratio (default 16:9)"),
    seed: z.number().int().min(0).optional().describe("Random seed for reproducibility"),
    _provider: z.string().optional().describe("Provider key (e.g., 'google')"),
  } satisfies ZodRawShape;
}

type Veo31ToolArgs = {
  book_id: string;
  prompt: string;
  first_frame_ref?: string;
  last_frame_ref?: string;
  image_refs?: string[];
  aspect_ratio?: (typeof VEO31_ASPECT_RATIOS)[number];
  duration?: (typeof VEO31_DURATIONS)[number];
  seed?: number;
};

function makeVeo31VideoTool(
  toolName: string,
  model: GoogleVeo31Model,
  allowRefs: boolean,
  description: string,
): (fs: Engine) => ToolDef {
  return (fs: Engine) => ({
    name: toolName,
    description,
    schema: buildVeo31Schema(allowRefs),
    handler: async (args) => {
      const raw = args as Veo31ToolArgs;
      const { book_id, prompt, aspect_ratio, duration, seed } = raw;
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";
      const firstFrameSlug = blank(raw.first_frame_ref) ? undefined : raw.first_frame_ref;
      const lastFrameSlug = blank(raw.last_frame_ref) ? undefined : raw.last_frame_ref;
      const imgs = (raw.image_refs ?? []).filter((s) => !blank(s));

      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "GOOGLE_FLOW_API_KEY environment variable is not set" }] };
      }
      if (lastFrameSlug !== undefined && firstFrameSlug === undefined) {
        return { isError: true as const, content: [{ type: "text" as const, text: "last_frame_ref requires first_frame_ref" }] };
      }
      if (imgs.length > 0 && firstFrameSlug !== undefined) {
        return { isError: true as const, content: [{ type: "text" as const, text: "Veo 3.1 reference images cannot be combined with a start frame — pick one mode" }] };
      }

      let firstFrame: RefInput | undefined;
      if (firstFrameSlug !== undefined) {
        const r = await resolveImageRef(fs, firstFrameSlug, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: `first_frame_ref: ${r.error}` }] };
        firstFrame = r.value;
      }
      let lastFrame: RefInput | undefined;
      if (lastFrameSlug !== undefined) {
        const r = await resolveImageRef(fs, lastFrameSlug, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: `last_frame_ref: ${r.error}` }] };
        lastFrame = r.value;
      }
      const imageInputs: RefInput[] = [];
      for (const ref of imgs) {
        const r = await resolveImageRef(fs, ref, book_id);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: `image_refs: ${r.error}` }] };
        imageInputs.push(r.value);
      }

      // Google Flow prompts only resolve positional @-markers; a raw @ref
      // mention 400s at submit (see generate-google-omni-video.ts).
      const normalizedPrompt = stripRefMentions(
        rewriteImageRefMentions(prompt, imgs),
        [
          ...(firstFrameSlug !== undefined ? [firstFrameSlug] : []),
          ...(lastFrameSlug !== undefined ? [lastFrameSlug] : []),
        ],
      );

      const modelSlugLiteral = VEO31_SLUGS[model];
      const videoName = `${modelSlugLiteral}-${slugify(prompt) || Date.now().toString(36)}`;
      const assetResult = await fs.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds: string[] = [];
      if (firstFrame) sourceImageIds.push(firstFrame.assetId);
      if (lastFrame && lastFrame.assetId !== firstFrame?.assetId) sourceImageIds.push(lastFrame.assetId);
      for (const input of imageInputs) sourceImageIds.push(input.assetId);
      const jobId = `${modelSlugLiteral}-${vidAssetId}-${Date.now()}`;

      await queue.enqueue(jobId, {
        type: "generate_veo31_video",
        veoModel: model,
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
        ...(firstFrame ? { firstFrame } : {}),
        ...(lastFrame ? { lastFrame } : {}),
        imageInputs,
        sourceImageIds,
        prompt: normalizedPrompt,
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(duration !== undefined ? { duration } : {}),
        ...(seed !== undefined ? { seed } : {}),
      } as unknown as Record<string, unknown>);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_images: sourceImageIds,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  });
}

export const generateVeo31VideoDef = makeVeo31VideoTool(
  "generate_google_flow_veo_3_1_quality_video",
  "veo-3.1-quality",
  false,
  "Generate a video using Google Veo 3.1 quality tier (Google Flow). Text-to-video or image-to-video from start/end frames; 8s output. Creates a new video artifact and enqueues a background job.",
);

export const generateVeo31FastVideoDef = makeVeo31VideoTool(
  "generate_google_flow_veo_3_1_fast_video",
  "veo-3.1-fast",
  true,
  "Generate a video using Google Veo 3.1 Fast (Google Flow). Text-to-video, image-to-video from start/end frames, or reference-to-video from up to 3 reference images. Creates a new video artifact and enqueues a background job.",
);

export const generateVeo31LiteVideoDef = makeVeo31VideoTool(
  "generate_google_flow_veo_3_1_lite_video",
  "veo-3.1-lite",
  true,
  "Generate a video using Google Veo 3.1 Lite (Google Flow). Cheapest Veo 3.1 tier: text-to-video, start/end frames, or up to 3 reference images. Creates a new video artifact and enqueues a background job.",
);

export const generateVeo31LiteLowPriorityVideoDef = makeVeo31VideoTool(
  "generate_google_flow_veo_3_1_lite_low_priority_video",
  "veo-3.1-lite-low-priority",
  true,
  "Generate a video using Google Veo 3.1 Lite Lower Priority (Google Flow, Ultra $199 only, 0 credits). Same modes as Lite (T2V / start-end I2V / up to 3 refs) with lower queue priority. Creates a new video artifact and enqueues a background job.",
);
