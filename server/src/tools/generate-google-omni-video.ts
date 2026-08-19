import type { Engine } from "videobook-engine";
import { z, type ZodRawShape } from "zod";
import { queue } from "../queue.js";
import {
  totalOmniReferenceSlots,
  canonicalCharacterId,
  rewriteImageRefMentions,
  stripRefMentions,
  OMNI_CHARACTER_SLOT_COST,
  OMNI_MAX_REFERENCE_SLOTS,
  OMNI_V2V_MAX_REFERENCE_SLOTS,
} from "../google-flow-refs.js";
import type { SchemaArgs, ToolDef } from "./tool-def.js";
import { resolveImageRef, resolveVideoRef, type RefInput } from "./_seedance2-shared.js";
import { generationLabel } from "../artifact-label.js";

// Literal slug — @apicity/cost has no google provider pricing, so modelSlug()
// would throw (docs/apicity-gaps.md §15).
const SLUG = "google-omni";

// Omni Flash reference budgets: R2V allows 7 reference slots, 5 alongside a
// V2V edit clip. Each image_refs ref costs 1 slot and each character a flat 2
// (Google receives every character entity twice — see google-flow-refs.ts), so
// at most 3 characters ever fit despite the API exposing character_1..7.
// Voices feed referenceAudio_1..5 (3 alongside a clip). Enums are hand-typed —
// the 0.7.3 @apicity/googleflow schemas carry only loose `.or(z.string())`
// model/aspect enums, not the per-model restrictions (docs/apicity-gaps.md §14)
// — and mirror the kie gemini-omni tool's values so provider switching keeps
// params valid.
const OMNI_MAX_VOICES = 5;
const OMNI_V2V_MAX_VOICES = 3;
const OMNI_MAX_CHARACTERS = 3;
// Schema cap stays at the structural character_1..7 param count — the slot
// budget is enforced in the handler so callers get a readable content error
// instead of a raw zod "too_big" MCP -32602 dump.
const GOOGLE_FLOW_MAX_CHARACTER_PARAMS = 7;
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
//   - replyUrl / replyRef — webhook completion; videocity polls via reconcile-project-work.ts.
//   - trimStart / trimEnd — removed from the videos type in 0.7.2; omni trims
//     via startFrameIndex_1 / endFrameIndex_1 (derived from the clip timecodes).
const generateGoogleOmniVideoSchema = {
  book_id: z.string().describe("Book id"),
  prompt: z.string().max(20000).describe("Multimodal video generation prompt (max 20000 characters). Inline mentions must use the positional markers @referenceImage_1..7 / @character_1..7 / @referenceAudio_1..5 (matching the body param order); @<artifact-id> mentions are rewritten to @referenceImage_N automatically, and reference clips cannot be mentioned inline"),
  first_frame_ref: z.string().optional().describe("First-frame image artifact id for image-to-video; not combinable with image_refs or video_ref"),
  image_refs: z.array(z.string()).max(7).optional().describe("Reference image artifact ids (0-7, or 0-5 with a reference clip); not combinable with first_frame_ref"),
  video_ref: z.string().optional().describe("Reference video clip artifact id for video editing (one clip); not combinable with first_frame_ref"),
  video_clip_start: z.number().min(0).max(10).optional().describe("Reference clip start time in seconds on a 10s timeline (requires video_ref)"),
  video_clip_ends: z.number().min(0).max(10).optional().describe("Reference clip end time in seconds on a 10s timeline; must be > start (requires video_ref)"),
  duration: z.enum(GOOGLE_OMNI_DURATIONS).optional().describe("Output duration in seconds: 4 / 6 / 8 / 10 (ignored when a reference video clip is supplied; default 8)"),
  aspect_ratio: z.enum(GOOGLE_OMNI_ASPECT_RATIOS).optional().describe("Output aspect ratio: 16:9 / 9:16 (sent as landscape / portrait)"),
  seed: z.number().int().min(0).optional().describe("Random seed for reproducibility"),
  voice_refs: z.array(z.string()).max(OMNI_MAX_VOICES).optional().describe("Google Flow voice refs from create_google_flow_voice (up to 5; up to 3 alongside a reference clip); sent as referenceAudio_1..5"),
  character_refs: z.array(z.string()).max(GOOGLE_FLOW_MAX_CHARACTER_PARAMS).optional().describe("Google Flow character refs from create_google_flow_character (up to 3); each character costs 2 of the 7 reference slots shared with image_refs (5 with a reference clip); not combinable with first_frame_ref"),
  _provider: z.string().optional().describe("Provider key (e.g., 'google')"),
} satisfies ZodRawShape;

type Args = SchemaArgs<typeof generateGoogleOmniVideoSchema>;

export function generateGoogleOmniVideoDef(engine: Engine): ToolDef {
  return {
    name: "generate_google_flow_omni_flash_video",
    description: "Generate a video using Google Gemini Omni via Google Flow. Multimodal: a text prompt plus optional first frame, reference images (0-7), or one reference video clip with in/out timecodes. Creates a new video artifact and enqueues a background job.",
    schema: generateGoogleOmniVideoSchema,
    handler: async (args) => {
      const raw = args as Args;
      const {
        book_id, prompt,
        first_frame_ref, image_refs, video_ref,
        video_clip_start, video_clip_ends,
        duration, aspect_ratio, seed,
        voice_refs, character_refs,
      } = raw;
      const blank = (v: unknown): v is "" => typeof v === "string" && v.trim() === "";

      if (!process.env.GOOGLE_FLOW_API_KEY) {
        return { isError: true as const, content: [{ type: "text" as const, text: "GOOGLE_FLOW_API_KEY environment variable is not set" }] };
      }

      const imgs = (image_refs ?? []).filter((s) => !blank(s));
      const videoRef = blank(video_ref) ? undefined : video_ref;
      const firstFrameSlug = blank(first_frame_ref) ? undefined : first_frame_ref;
      const voiceRefs = (voice_refs ?? []).filter((s) => !blank(s));
      const charRefs = (character_refs ?? []).filter((s) => !blank(s));

      // Omni Flash modes are mutually exclusive: startImage I2V
      // (first_frame_ref) cannot combine with referenceImage_* (image_refs)
      // or referenceVideo_1 V2V (video_ref). Characters are reference-mode
      // inputs, so they cannot ride start-image I2V either.
      if (firstFrameSlug !== undefined) {
        if (imgs.length > 0) {
          return { isError: true as const, content: [{ type: "text" as const, text: "first_frame_ref cannot be combined with image_refs — Omni Flash start-image I2V does not accept reference images" }] };
        }
        if (videoRef !== undefined) {
          return { isError: true as const, content: [{ type: "text" as const, text: "first_frame_ref cannot be combined with video_ref — Omni Flash start-image I2V and reference-video V2V are mutually exclusive" }] };
        }
        if (charRefs.length > 0) {
          return { isError: true as const, content: [{ type: "text" as const, text: "first_frame_ref cannot be combined with character_refs — Omni Flash characters are reference-mode inputs" }] };
        }
      }

      // Voice/character budgets. Each character costs a flat 2 of the shared
      // reference-slot pool regardless of its `-imgs:N` suffix (Google receives
      // the entity twice — see google-flow-refs.ts), so overflow is enforced
      // here in slots, not deferred to an opaque upstream 400.
      if (voiceRefs.length > OMNI_MAX_VOICES) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Omni Flash supports at most ${OMNI_MAX_VOICES} voice refs (got ${voiceRefs.length})` }] };
      }
      if (videoRef !== undefined && voiceRefs.length > OMNI_V2V_MAX_VOICES) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Omni Flash video edit supports at most ${OMNI_V2V_MAX_VOICES} voice refs alongside the clip (got ${voiceRefs.length})` }] };
      }
      if (charRefs.length > OMNI_MAX_CHARACTERS) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Omni Flash supports at most ${OMNI_MAX_CHARACTERS} character refs — each costs ${OMNI_CHARACTER_SLOT_COST} of the ${OMNI_MAX_REFERENCE_SLOTS} reference slots (got ${charRefs.length}). Remove ${charRefs.length - OMNI_MAX_CHARACTERS} character${charRefs.length - OMNI_MAX_CHARACTERS === 1 ? "" : "s"}` }] };
      }
      const seenChars = new Set<string>();
      for (const ref of charRefs) {
        const canonical = canonicalCharacterId(ref);
        if (seenChars.has(canonical)) {
          return { isError: true as const, content: [{ type: "text" as const, text: `Duplicate character in character_refs: ${ref}` }] };
        }
        seenChars.add(canonical);
      }
      const omniSlotBudget = videoRef !== undefined ? OMNI_V2V_MAX_REFERENCE_SLOTS : OMNI_MAX_REFERENCE_SLOTS;
      const omniSlotTotal = totalOmniReferenceSlots(imgs.length, charRefs);
      if (omniSlotTotal > omniSlotBudget) {
        const budgetLabel = videoRef !== undefined ? `${OMNI_V2V_MAX_REFERENCE_SLOTS} alongside a reference clip` : `${OMNI_MAX_REFERENCE_SLOTS}`;
        return { isError: true as const, content: [{ type: "text" as const, text: `Omni Flash reference budget exceeded: image_refs cost 1 slot each and characters ${OMNI_CHARACTER_SLOT_COST} each, at most ${budgetLabel} total (got ${omniSlotTotal}: ${imgs.length} image_refs + ${charRefs.length} character ref${charRefs.length === 1 ? "" : "s"} × ${OMNI_CHARACTER_SLOT_COST})` }] };
      }

      // Clip-timing pre-check mirroring the kie gemini-omni tool. Omni Flash
      // trims on a 24fps / 240-frame timeline, so the window may span up to
      // but not exceed exactly 10 seconds.
      if (videoRef !== undefined) {
        const start = video_clip_start ?? 0;
        const ends = video_clip_ends;
        if (video_clip_start !== undefined && video_clip_start >= 10) {
          return { isError: true as const, content: [{ type: "text" as const, text: "video_clip_start must be less than 10 seconds" }] };
        }
        if (ends !== undefined && (!(ends > start) || ends > 10)) {
          return { isError: true as const, content: [{ type: "text" as const, text: "video_clip_ends must be greater than video_clip_start and at most 10 seconds" }] };
        }
      }

      const imageInputs: RefInput[] = [];
      for (const slug of imgs) {
        const r = await resolveImageRef(engine, slug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        imageInputs.push(r.value);
      }

      let firstFrame: RefInput | undefined;
      if (firstFrameSlug !== undefined) {
        const r = await resolveImageRef(engine, firstFrameSlug);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        firstFrame = r.value;
      }

      let videoInput: RefInput | undefined;
      if (videoRef !== undefined) {
        const r = await resolveVideoRef(engine, videoRef);
        if (!r.ok) return { isError: true as const, content: [{ type: "text" as const, text: r.error }] };
        videoInput = r.value;
      }

      // Google Flow resolves inline @-mentions against the positional markers
      // only (@referenceImage_N / @character_N / @referenceAudio_N); any other
      // @-token — an asset slug, a character handle — draws an opaque 400 at
      // submit. Rewrite image-artifact mentions to their positional marker and
      // drop clip/first-frame mentions, which have no inline form.
      const normalizedPrompt = stripRefMentions(
        rewriteImageRefMentions(prompt, imgs),
        [
          ...(videoRef !== undefined ? [videoRef] : []),
          ...(firstFrameSlug !== undefined ? [firstFrameSlug] : []),
        ],
      );

      const videoName = generationLabel(SLUG, prompt);
      const assetResult = await engine.artifacts.create("vid", videoName);
      if (!assetResult.ok) {
        return { isError: true as const, content: [{ type: "text" as const, text: `Failed to create video asset: ${assetResult.error.message}` }] };
      }

      const { artifactId: vidAssetId, path: vidAssetDir } = assetResult.value;
      const sourceImageIds = imageInputs.map((i) => i.assetId);
      const sourceVideoIds = videoInput ? [videoInput.assetId] : [];
      const sourceFirstFrameId = firstFrame ? firstFrame.assetId : undefined;
      const jobId = `${SLUG}-${vidAssetId}-${Date.now()}`;

      const jobPayload = {
        type: "generate_google_omni_video",
        vidAssetId,
        vidAssetDir,
        bookId: book_id,
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
      await engine.metadata.artifacts.write(vidAssetId, "generation-request", jobPayload);

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
