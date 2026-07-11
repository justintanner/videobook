import type { VideocityFs } from "videocity-engine";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import { totalOmniReferenceImages, canonicalCharacterId, rewriteImageSlugMentions, stripSlugMentions } from "../google-flow-refs.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageSlug, resolveVideoSlug, slugify, type RefInput } from "./_seedance2-shared.js";

// Literal slug — @apicity/cost has no google provider pricing, so modelSlug()
// would throw (docs/apicity-gaps.md §15).
const SLUG = "google-omni";

// Omni Flash reference budgets (useapi.net docs): R2V allows 7 reference
// images; a V2V edit clip allows 5 alongside it. Voices feed referenceAudio_1..5
// (3 alongside a clip); characters feed character_1..7, whose own images share
// the 7-image budget with image_slugs. Enums are hand-typed — the 0.7.2
// @apicity/googleflow schemas carry only loose `.or(z.string())` model/aspect
// enums, not the per-model restrictions (docs/apicity-gaps.md §14) — and mirror
// the kie gemini-omni tool's values so provider switching keeps params valid.
const OMNI_V2V_MAX_IMAGES = 5;
const OMNI_MAX_VOICES = 5;
const OMNI_V2V_MAX_VOICES = 3;
const OMNI_MAX_CHARACTERS = 7;
const OMNI_MAX_REFERENCE_IMAGES = 7;
const GOOGLE_OMNI_DURATIONS = ["4", "6", "8", "10"] as const;
const GOOGLE_OMNI_ASPECT_RATIOS = ["16:9", "9:16"] as const;

// Gemini Omni ("Omni Flash") on Google Flow: multimodal text/image/clip-to-
// video, the direct-Google alternative to the kie-proxied
// generate_gemini_omni_video.
//
// Deliberately not exposed (all valid upstream, intentionally omitted):
//   - endImage (last frame) — veo-only; omni-flash rejects it.
//   - count (1-4 variations) — videocity persists exactly one asset per
//     generation; the provider default is 1.
//   - email — single configured account; multi-account routing is out of scope.
//   - captchaToken — user-supplied reCAPTCHA tokens (provider-side
//     captchaRetry is applied in jobs/_google-flow.ts; captchaOrder via
//     GOOGLE_FLOW_CAPTCHA_ORDER).
//   - replyUrl / replyRef — webhook completion; videocity polls via sync.ts.
//   - trimStart / trimEnd — removed from the videos type in 0.7.2; omni trims
//     via startFrameIndex_1 / endFrameIndex_1 (derived from the clip timecodes).
const generateGoogleOmniVideoSchema = {
  project_slug: z.string().describe("Project slug"),
  prompt: z.string().max(20000).describe("Multimodal video generation prompt (max 20000 characters). Inline mentions must use the positional markers @referenceImage_1..7 / @character_1..7 / @referenceAudio_1..5 (matching the body param order); @<image-slug> mentions are rewritten to @referenceImage_N automatically, and reference clips cannot be mentioned inline"),
  first_frame_slug: z.string().optional().describe("First-frame image asset for image-to-video (e.g., @img-start); not combinable with image_slugs or video_slug"),
  image_slugs: z.array(z.string()).max(7).optional().describe("Reference image @slugs (0-7, or 0-5 with a reference clip, e.g., @img-style); not combinable with first_frame_slug"),
  video_slug: z.string().optional().describe("Reference video clip @slug for video editing (one clip, e.g., @vid-motion); not combinable with first_frame_slug"),
  video_clip_start: z.number().min(0).max(10).optional().describe("Reference clip start time in seconds on a 10s timeline (requires video_slug)"),
  video_clip_ends: z.number().min(0).max(10).optional().describe("Reference clip end time in seconds on a 10s timeline; must be > start (requires video_slug)"),
  duration: z.enum(GOOGLE_OMNI_DURATIONS).optional().describe("Output duration in seconds: 4 / 6 / 8 / 10 (ignored when a reference video clip is supplied; default 8)"),
  aspect_ratio: z.enum(GOOGLE_OMNI_ASPECT_RATIOS).optional().describe("Output aspect ratio: 16:9 / 9:16 (sent as landscape / portrait)"),
  seed: z.number().int().min(0).optional().describe("Random seed for reproducibility"),
  voice_refs: z.array(z.string()).max(OMNI_MAX_VOICES).optional().describe("Google Flow voice refs from create_google_flow_voice (up to 5; up to 3 alongside a reference clip); sent as referenceAudio_1..5"),
  character_refs: z.array(z.string()).max(OMNI_MAX_CHARACTERS).optional().describe("Google Flow character refs from create_google_flow_character (up to 7); each character's 1-2 images share the 7-image reference budget with image_slugs; not combinable with first_frame_slug"),
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
        voice_refs, character_refs,
      } = raw;
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";

      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "GOOGLE_FLOW_API_KEY environment variable is not set" }] };
      }

      const imgs = (image_slugs ?? []).filter((s) => !blank(s));
      const videoSlug = blank(video_slug) ? undefined : video_slug;
      const firstFrameSlug = blank(first_frame_slug) ? undefined : first_frame_slug;
      const voiceRefs = (voice_refs ?? []).filter((s) => !blank(s));
      const charRefs = (character_refs ?? []).filter((s) => !blank(s));

      // Omni Flash modes are mutually exclusive: startImage I2V
      // (first_frame_slug) cannot combine with referenceImage_* (image_slugs)
      // or referenceVideo_1 V2V (video_slug). Characters are reference-mode
      // inputs, so they cannot ride start-image I2V either.
      if (firstFrameSlug !== undefined) {
        if (imgs.length > 0) {
          return { isError: true as const, content: [{ type: "text" as const, text: "first_frame_slug cannot be combined with image_slugs — Omni Flash start-image I2V does not accept reference images" }] };
        }
        if (videoSlug !== undefined) {
          return { isError: true as const, content: [{ type: "text" as const, text: "first_frame_slug cannot be combined with video_slug — Omni Flash start-image I2V and reference-video V2V are mutually exclusive" }] };
        }
        if (charRefs.length > 0) {
          return { isError: true as const, content: [{ type: "text" as const, text: "first_frame_slug cannot be combined with character_refs — Omni Flash characters are reference-mode inputs" }] };
        }
      }

      // Voice/character budgets. Each character carries 1-2 images (useapi.net
      // `-imgs:N` suffix) that share the 7-image reference budget with
      // image_slugs; totalOmniReferenceImages sums the exact per-character
      // counts so two-image characters are enforced here, not deferred.
      if (voiceRefs.length > OMNI_MAX_VOICES) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Omni Flash supports at most ${OMNI_MAX_VOICES} voice refs (got ${voiceRefs.length})` }] };
      }
      if (videoSlug !== undefined && voiceRefs.length > OMNI_V2V_MAX_VOICES) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Omni Flash video edit supports at most ${OMNI_V2V_MAX_VOICES} voice refs alongside the clip (got ${voiceRefs.length})` }] };
      }
      if (charRefs.length > OMNI_MAX_CHARACTERS) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Omni Flash supports at most ${OMNI_MAX_CHARACTERS} character refs (got ${charRefs.length})` }] };
      }
      const seenChars = new Set<string>();
      for (const ref of charRefs) {
        const canonical = canonicalCharacterId(ref);
        if (seenChars.has(canonical)) {
          return { isError: true as const, content: [{ type: "text" as const, text: `Duplicate character in character_refs: ${ref}` }] };
        }
        seenChars.add(canonical);
      }
      const omniRefTotal = totalOmniReferenceImages(imgs.length, charRefs);
      if (omniRefTotal > OMNI_MAX_REFERENCE_IMAGES) {
        const charImageTotal = omniRefTotal - imgs.length;
        return { isError: true as const, content: [{ type: "text" as const, text: `Omni Flash reference budget exceeded: image_slugs plus character images must total at most ${OMNI_MAX_REFERENCE_IMAGES} reference images (got ${omniRefTotal}: ${imgs.length} image_slugs + ${charImageTotal} from ${charRefs.length} character ref${charRefs.length === 1 ? "" : "s"})` }] };
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

      // Google Flow resolves inline @-mentions against the positional markers
      // only (@referenceImage_N / @character_N / @referenceAudio_N); any other
      // @-token — an asset slug, a character handle — draws an opaque 400 at
      // submit. Rewrite image-slug mentions to their positional marker and
      // drop clip/first-frame mentions, which have no inline form.
      const normalizedPrompt = stripSlugMentions(
        rewriteImageSlugMentions(prompt, imgs),
        [
          ...(videoSlug !== undefined ? [videoSlug] : []),
          ...(firstFrameSlug !== undefined ? [firstFrameSlug] : []),
        ],
      );

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

      const jobPayload = {
        type: "generate_google_omni_video",
        vidAssetId,
        vidAssetDir,
        projectSlug: project_slug,
        ...(firstFrame ? { firstFrame } : {}),
        imageInputs,
        ...(videoInput ? { videoInput } : {}),
        sourceImageIds,
        sourceVideoIds,
        prompt: normalizedPrompt,
        ...(duration !== undefined ? { duration } : {}),
        ...(aspect_ratio !== undefined ? { aspect_ratio } : {}),
        ...(seed !== undefined ? { seed } : {}),
        ...(video_clip_start !== undefined ? { video_clip_start } : {}),
        ...(video_clip_ends !== undefined ? { video_clip_ends } : {}),
        ...(voiceRefs.length > 0 ? { voice_refs: voiceRefs } : {}),
        ...(charRefs.length > 0 ? { character_refs: charRefs } : {}),
      } as unknown as Record<string, unknown>;

      // Persist the exact enqueued payload so retry_generation can replay it
      // after a failure without re-resolving inputs.
      await fs.writeMetadata(vidAssetId, "generation-request", jobPayload, project_slug);

      await queue.enqueue(jobId, jobPayload);

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            vid_asset_id: vidAssetId,
            source_first_frame: sourceFirstFrameId ?? null,
            source_images: sourceImageIds,
            source_videos: sourceVideoIds,
            voice_refs: voiceRefs,
            character_refs: charRefs,
            job_id: jobId,
            status: "enqueued",
          }),
        }],
      };
    },
  };
}
