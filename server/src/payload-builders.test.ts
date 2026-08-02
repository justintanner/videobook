import { describe, expect, it } from "vitest";
import { computeEstimate } from "@apicity/cost";
import {
  GrokVideoExtendRequestSchema,
  KlingMotionControlRequestSchema,
  KlingV3TurboImageToVideoRequestSchema,
  KlingV3TurboTextToVideoRequestSchema,
  Seedance2MiniRequestSchema,
  VolcengineVideoToVideoLipSyncRequestSchema,
  Wan27ImageRequestSchema,
} from "@apicity/kie/zod";
import { GoogleFlowVideosRequestSchema } from "@apicity/googleflow/zod";
import { normalizeKieCostPayload } from "./cost-adapters.js";
import { translateToolPayload } from "./payload-builders.js";

describe("translateToolPayload", () => {
  it("materializes Kling motion-control defaults when controls are Auto", () => {
    const result = translateToolPayload("generate_kie_kling_3_0_motion_control", {
      character_image_slugs: ["@img-character"],
      motion_video_slugs: ["@vid-motion"],
      mode: "",
      character_orientation: "",
      background_source: "",
    });

    expect(result?.payload).toEqual({
      model: "kling-3.0/motion-control",
      input: {
        input_urls: ["@img-character"],
        video_urls: ["@vid-motion"],
        mode: "720p",
        character_orientation: "video",
        background_source: "input_video",
      },
    });
    expect(KlingMotionControlRequestSchema.safeParse(result?.payload).success).toBe(true);
    if (!result) throw new Error("Expected Kling motion-control payload");
    const estimate = computeEstimate({
      provider: "kie",
      payload: normalizeKieCostPayload(result.payload, { duration: 6 }),
    });
    expect(estimate.warnings).toEqual([]);
  });

  it("preserves explicit Kling motion-control settings", () => {
    const result = translateToolPayload("generate_kie_kling_3_0_motion_control", {
      character_image_slugs: ["@img-character"],
      motion_video_slugs: ["@vid-motion"],
      mode: "1080p",
      character_orientation: "image",
      background_source: "input_image",
    });

    expect(result?.payload.input).toMatchObject({
      mode: "1080p",
      character_orientation: "image",
      background_source: "input_image",
    });
    expect(KlingMotionControlRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("uses Apicity defaults for Kling Turbo text-to-video", () => {
    const result = translateToolPayload("generate_kling30_turbo_video", {
      prompt: "clouds crossing a mountain",
    });

    expect(result?.payload).toEqual({
      model: "kling/v3-turbo-text-to-video",
      input: {
        prompt: "clouds crossing a mountain",
        duration: "5",
        aspect_ratio: "16:9",
        resolution: "720p",
      },
    });
    expect(KlingV3TurboTextToVideoRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("honors Kling Turbo image-to-video resolution and applies shared defaults", () => {
    const result = translateToolPayload("generate_kling30_turbo_video", {
      prompt: "turn toward the camera",
      image_slugs: ["https://example.test/input.png"],
      resolution: "1080p",
    });

    expect(result?.payload).toEqual({
      model: "kling/v3-turbo-image-to-video",
      input: {
        prompt: "turn toward the camera",
        image_urls: ["https://example.test/input.png"],
        duration: "5",
        resolution: "1080p",
      },
    });
    expect(KlingV3TurboImageToVideoRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("uses Apicity defaults for Wan 2.7 image generation", () => {
    const result = translateToolPayload("generate_wan27_image", {
      prompt: "a quiet lakeside cabin",
    });

    expect(result?.payload).toEqual({
      model: "wan/2-7-image",
      input: {
        prompt: "a quiet lakeside cabin",
        aspect_ratio: "16:9",
        resolution: "2K",
        nsfw_checker: false,
      },
    });
    expect(Wan27ImageRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("uses Apicity defaults for Volcengine lip sync", () => {
    const result = translateToolPayload("generate_volcengine_lipsync_video", {
      video_slug: "https://example.test/input.mp4",
      audio_slug: "https://example.test/input.mp3",
      mode: "lite",
    });

    expect(result?.payload).toEqual({
      model: "volcengine/video-to-video-lip-sync",
      input: {
        mode: "lite",
        video_url: "https://example.test/input.mp4",
        audio_url: "https://example.test/input.mp3",
        separate_vocal: false,
        open_scenedet: false,
        align_audio: true,
        align_audio_reverse: false,
        templ_start_seconds: 0,
      },
    });
    expect(VolcengineVideoToVideoLipSyncRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds current Kie Grok image-to-video payload with mode", () => {
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_slugs: ["https://example.test/input.png"],
      prompt: "wave at camera",
      mode: "fun",
      duration: 8,
      resolution: "720p",
      aspect_ratio: "16:9",
      nsfw_checker: false,
    });

    // image_urls path: no index (index is task_id-only per Kie docs)
    expect(result?.payload).toEqual({
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: ["https://example.test/input.png"],
        prompt: "wave at camera",
        mode: "fun",
        aspect_ratio: "16:9",
        resolution: "720p",
        duration: 8,
        nsfw_checker: false,
      },
    });
    expect(result?.payload.input).not.toHaveProperty("index");
    expect(result?.payload.input).not.toHaveProperty("task_id");
  });

  it("materializes all Kie Grok image-to-video defaults in previews", () => {
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_slugs: ["@img-input"],
      prompt: "wave at camera",
      aspect_ratio: "9:16",
    });

    expect(result?.payload).toEqual({
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: ["@img-input"],
        prompt: "wave at camera",
        mode: "normal",
        aspect_ratio: "9:16",
        resolution: "480p",
        duration: 6,
        nsfw_checker: false,
      },
    });
  });

  it("rewrites @img-* prompt mentions to Kie @imageN form", () => {
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_slugs: ["@img-nbp-reference-1-reference"],
      prompt: "@img-nbp-reference-1-reference in bangkok high on shrooms",
      mode: "fun",
      duration: 6,
      resolution: "720p",
      aspect_ratio: "1:1",
    });

    expect(result?.payload).toMatchObject({
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: ["@img-nbp-reference-1-reference"],
        prompt: "@image1 in bangkok high on shrooms",
        mode: "fun",
        duration: 6,
        resolution: "720p",
        aspect_ratio: "1:1",
      },
    });
    expect(result?.payload.input).not.toHaveProperty("index");
  });

  it("orders image_urls by first prompt mention so @image1 is the first named image", () => {
    // Tool-call list order is [lay, catblack] but the prompt names catblack first.
    // Kie @imageN is the Nth entry of image_urls — reorder so mentions stay
    // natural: "@image1 morphs into @image2".
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_slugs: ["@img-lay", "@img-catblack"],
      prompt: "@img-catblack morphs into @img-lay",
      mode: "normal",
      duration: 6,
      resolution: "720p",
      aspect_ratio: "1:1",
      nsfw_checker: false,
    });

    expect(result?.payload).toEqual({
      model: "grok-imagine/image-to-video",
      input: {
        image_urls: ["@img-catblack", "@img-lay"],
        prompt: "@image1 morphs into @image2",
        mode: "normal",
        aspect_ratio: "1:1",
        resolution: "720p",
        duration: 6,
        nsfw_checker: false,
      },
    });
  });

  it("normalizes spicy mode for uploaded Grok image-to-video inputs", () => {
    const result = translateToolPayload("generate_grok_imagine_video", {
      image_slugs: ["https://example.test/input.png"],
      mode: "spicy",
    });

    expect(result?.payload.input).toMatchObject({
      mode: "normal",
    });
  });

  it("builds a schema-valid Grok video extension payload", () => {
    const result = translateToolPayload("extend_grok_imagine_video", {
      prompt: "continue through the doorway",
      extend_at: 3,
      extend_times: "10",
    });

    expect(result?.payload).toEqual({
      model: "grok-imagine/extend",
      input: {
        task_id: "<task_id_from_source_video_metadata>",
        prompt: "continue through the doorway",
        extend_at: 3,
        extend_times: "10",
      },
    });
    expect(GrokVideoExtendRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds a schema-valid Seedance 2 Mini payload (refs, no first/last frame)", () => {
    const result = translateToolPayload("generate_seedance2_mini_video", {
      prompt: "a tiny horse trotting",
      image_slugs: ["https://example.test/ref.png"],
      video_slugs: ["https://example.test/motion.mp4"],
      aspect_ratio: "adaptive",
      resolution: "720p",
      duration: "12",
      generate_audio: true,
      nsfw_checker: false,
    });

    expect(result?.payload).toEqual({
      model: "bytedance/seedance-2-mini",
      input: {
        prompt: "a tiny horse trotting",
        reference_image_urls: ["https://example.test/ref.png"],
        reference_video_urls: ["https://example.test/motion.mp4"],
        aspect_ratio: "adaptive",
        resolution: "720p",
        duration: 12,
        generate_audio: true,
        // Schema defaults still fill omitted optional toggles (web_search).
        web_search: false,
        nsfw_checker: false,
      },
    });
    expect(Seedance2MiniRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  // vc-3vn2: omitting resolution with reference_video_urls used to mint an
  // unbounded cost key (variant 'video' instead of '720p|video').
  it("defaults Seedance 2 Mini resolution/duration so cost can key video rates", () => {
    const result = translateToolPayload("generate_seedance2_mini_video", {
      prompt: "scene continuity",
      video_slugs: ["https://example.test/scene.mp4"],
    });

    expect(result?.payload).toMatchObject({
      model: "bytedance/seedance-2-mini",
      input: {
        prompt: "scene continuity",
        reference_video_urls: ["https://example.test/scene.mp4"],
        resolution: "720p",
        duration: 15,
      },
    });
    expect(Seedance2MiniRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds Veo 3.1 lite-low-priority payload with model literal", () => {
    const result = translateToolPayload("generate_google_flow_veo_3_1_lite_low_priority_video", {
      prompt: "slow clouds",
      duration: "4",
      aspect_ratio: "16:9",
      image_slugs: ["ref-1"],
    });
    expect(result?.provider_path).toBe("googleflow.v1.videos({ async: true })");
    // Reference-to-video requires duration 8 under the current Google Flow schema.
    expect(result?.payload).toEqual({
      prompt: "slow clouds",
      model: "veo-3.1-lite-low-priority",
      duration: 8,
      aspectRatio: "landscape",
      referenceImage_1: "ref-1",
    });
    expect(GoogleFlowVideosRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds Google Omni I2V payload with startImage", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "animate the first frame",
      first_frame_slug: "user:123-email:test-image:start",
      duration: "6",
      aspect_ratio: "9:16",
    });

    expect(result?.provider_path).toBe("googleflow.v1.videos({ async: true })");
    expect(result?.payload).toEqual({
      prompt: "animate the first frame",
      model: "omni-flash",
      duration: 6,
      aspectRatio: "portrait",
      startImage: "user:123-email:test-image:start",
    });
  });

  it("builds Google Omni R2V payload with reference images and default duration", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "use these references",
      image_slugs: ["ref-1", "ref-2"],
      aspect_ratio: "16:9",
    });

    expect(result?.payload).toEqual({
      prompt: "use these references",
      model: "omni-flash",
      duration: 8,
      aspectRatio: "landscape",
      referenceImage_1: "ref-1",
      referenceImage_2: "ref-2",
    });
  });

  it("builds Google Omni V2V payload without duration and with explicit frame indexes", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "edit the clip",
      video_slug: "user:123-email:test-video:clip",
      image_slugs: ["ref-1"],
      duration: "10",
      video_clip_start: 2,
      video_clip_ends: 10,
    });

    expect(result?.payload).toEqual({
      prompt: "edit the clip",
      model: "omni-flash",
      referenceImage_1: "ref-1",
      referenceVideo_1: "user:123-email:test-video:clip",
      startFrameIndex_1: 48,
      endFrameIndex_1: 240,
    });
  });

  it("edit-mode-filtered args (no duration key) produce the same V2V wire as duration-present", () => {
    // The client's mode filter OMITS duration in edit mode; the builder drops
    // it anyway when a clip is present. Both must yield the identical payload.
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "edit the clip",
      video_slug: "user:123-email:test-video:clip",
      image_slugs: ["ref-1"],
      video_clip_start: 2,
      video_clip_ends: 10,
    });

    expect(result?.payload).toEqual({
      prompt: "edit the clip",
      model: "omni-flash",
      referenceImage_1: "ref-1",
      referenceVideo_1: "user:123-email:test-video:clip",
      startFrameIndex_1: 48,
      endFrameIndex_1: 240,
    });
  });

  it("builds Google Omni V2V payload without fabricated trim indexes", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "edit the clip",
      video_slug: "user:123-email:test-video:clip",
      duration: "8",
    });

    expect(result?.payload).toEqual({
      prompt: "edit the clip",
      model: "omni-flash",
      referenceVideo_1: "user:123-email:test-video:clip",
    });
  });

  it("builds Google Omni R2V payload with voice refs (referenceAudio_N) and character refs (character_N)", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "cast these",
      image_slugs: ["ref-1"],
      voice_refs: ["voice:aaa", "voice:bbb"],
      character_refs: ["character:ccc"],
      aspect_ratio: "16:9",
    });

    expect(result?.payload).toEqual({
      prompt: "cast these",
      model: "omni-flash",
      duration: 8,
      aspectRatio: "landscape",
      referenceImage_1: "ref-1",
      referenceAudio_1: "voice:aaa",
      referenceAudio_2: "voice:bbb",
      character_1: "character:ccc",
    });
    // Payload validates against the tightened 0.7.2 videos request schema
    // (numeric-literal duration, named ref slots).
    expect(GoogleFlowVideosRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("builds Google Omni V2V payload with voice refs and no duration", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "edit with narration",
      video_slug: "user:123-email:test-video:clip",
      voice_refs: ["voice:aaa"],
      duration: "8",
    });

    expect(result?.payload).toEqual({
      prompt: "edit with narration",
      model: "omni-flash",
      referenceVideo_1: "user:123-email:test-video:clip",
      referenceAudio_1: "voice:aaa",
    });
    expect(GoogleFlowVideosRequestSchema.safeParse(result?.payload).success).toBe(true);
  });

  it("rewrites @slug prompt mentions to @reference_N for Nano Banana Pro (Google)", () => {
    const result = translateToolPayload("generate_nano_banana_pro_google", {
      prompt: "@img-vancat in multiple poses like @img-shots in the purple nebula",
      image_slugs: ["@img-shots", "@img-vcprof", "@img-vancat"],
      aspect_ratio: "16:9",
      book_id: "realcat",
    }, "google");

    expect(result?.provider_path).toBe("googleflow.v1.images()");
    expect(result?.payload).toEqual({
      prompt: "@reference_3 in multiple poses like @reference_1 in the purple nebula",
      model: "nano-banana-pro",
      count: 1,
      aspectRatio: "16:9",
      reference_1: "@img-shots",
      reference_2: "@img-vcprof",
      reference_3: "@img-vancat",
    });
  });

  it("rewrites @slug mentions to @referenceImage_N and strips frame mentions for Veo 3.1", () => {
    const result = translateToolPayload("generate_veo31_video", {
      prompt: "pan across @img-set starting from @img-open",
      image_slugs: ["img-set"],
      first_frame_slug: "img-open",
      duration: "4",
      aspect_ratio: "16:9",
    });

    expect(result?.payload).toEqual({
      prompt: "pan across @referenceImage_1 starting from",
      model: "veo-3.1-quality",
      // Reference-image R2V only accepts duration 8 under current schema.
      duration: 8,
      aspectRatio: "landscape",
      startImage: "img-open",
      referenceImage_1: "img-set",
    });
  });

  it("rewrites @slug mentions and strips the clip mention for Google Omni V2V", () => {
    const result = translateToolPayload("generate_google_omni_video", {
      prompt: "put @img-hat into @vid-clip",
      video_slug: "vid-clip",
      image_slugs: ["img-hat"],
    });

    expect(result?.payload).toEqual({
      prompt: "put @referenceImage_1 into",
      model: "omni-flash",
      referenceImage_1: "img-hat",
      referenceVideo_1: "vid-clip",
    });
  });

  it("normalizes @slug mentions in HappyHorse video-edit prompts for the preview", () => {
    // happyhorse/video-edit (1.0) has no inline marker syntax, so the preview
    // rewrites @<slug> mentions to natural-language noun phrases — the user
    // sees exactly what will hit the wire (no local asset IDs, references
    // still unambiguous by position).
    const result = translateToolPayload("generate_happyhorse_videoedit_video", {
      prompt: "Replace the boy in @vid-scene-1 with the character in @img-spongebob, then add @img-extra style",
      video_slug: "@vid-scene-1",
      image_slugs: ["@img-spongebob", "img-extra"],
      resolution: "1080p",
    });

    expect(result?.payload).toEqual({
      model: "happyhorse/video-edit",
      input: {
        prompt: "Replace the boy in the source video with the character in reference image 1, then add reference image 2 style",
        video_url: "@vid-scene-1",
        reference_image: ["@img-spongebob", "img-extra"],
        resolution: "1080p",
      },
    });
  });

  it("strips @slugs from the exact vc-4oab repro prompt", () => {
    // Observed in production: video-edit step submitted prompt
    // 'scene @vid-full-notats replace attress with @img-nbp-scene-reference-1-5'
    // and the provider payload carried that exact string, leaking local asset
    // IDs to HappyHorse. Both the preview and the runtime path now rewrite.
    const result = translateToolPayload("generate_happyhorse_videoedit_video", {
      prompt: "scene @vid-full-notats replace attress with @img-nbp-scene-reference-1-5",
      video_slug: "vid-full-notats",
      image_slugs: ["img-nbp-scene-reference-1-5"],
    });

    const prompt = (result?.payload as { input: { prompt: string } }).input.prompt;
    expect(prompt).not.toMatch(/@vid-/);
    expect(prompt).not.toMatch(/@img-/);
    expect(prompt).toBe("scene the source video replace attress with reference image 1");
  });

  it("leaves non-asset @text untouched in HappyHorse video-edit prompts", () => {
    // Stray @tokens that aren't in video_slug/image_slugs stay literal — only
    // confirmed asset slugs are rewritten.
    const result = translateToolPayload("generate_happyhorse_videoedit_video", {
      prompt: "@notify support about @vid-clip and @img-char",
      video_slug: "vid-clip",
      image_slugs: ["img-char"],
    });

    expect((result?.payload as { input: { prompt: string } }).input.prompt).toBe(
      "@notify support about the source video and reference image 1",
    );
  });

  it("passes HappyHorse video-edit prompts that already read naturally", () => {
    const result = translateToolPayload("generate_happyhorse_videoedit_video", {
      prompt: "Replace the teenage boy in the video with SpongeBob SquarePants.",
      video_slug: "vid-clip",
      image_slugs: ["img-char"],
    });

    expect((result?.payload as { input: { prompt: string } }).input.prompt).toBe(
      "Replace the teenage boy in the video with SpongeBob SquarePants.",
    );
  });

  it("rewrites HappyHorse ref prompts to [Image N] markers", () => {
    const result = translateToolPayload("generate_happyhorse_ref_video", {
      prompt: "the woman in @img-char waves at the camera",
      image_slugs: ["img-char", "img-bg"],
    });

    expect((result?.payload as { input: { prompt: string } }).input.prompt).toBe(
      "the woman in [Image 1] waves at the camera",
    );
  });

  it("rewrites Seedance @slug mentions to @ImageN/@VideoN/@AudioN", () => {
    const result = translateToolPayload("generate_seedance2_video", {
      prompt: "animate @img-hero like @vid-motion with @aud-score",
      image_slugs: ["img-hero"],
      video_slugs: ["vid-motion"],
      audio_slugs: ["aud-score"],
    });

    expect((result?.payload as { input: { prompt: string } }).input.prompt).toBe(
      "animate @Image1 like @Video1 with @Audio1",
    );
  });

  it("rewrites the Seedance 2 Mini sidebar repro prompt (vc-gb9g)", () => {
    // GEN VIDEO /provider-payload showed:
    //   prompt: "scene @vid-full-notats replace attress with @img-actress"
    // Wire form must use Seedance markers so the user can visually verify the
    // outbound text; URL fields may still show local slugs as placeholders.
    const result = translateToolPayload("generate_seedance2_mini_video", {
      prompt: "scene @vid-full-notats replace attress with @img-actress",
      image_slugs: ["@img-actress"],
      video_slugs: ["@vid-full-notats"],
      aspect_ratio: "16:9",
      resolution: "720p",
      duration: "15",
      generate_audio: true,
      web_search: false,
    });

    const input = (result?.payload as {
      model: string;
      input: {
        prompt: string;
        reference_image_urls: string[];
        reference_video_urls: string[];
      };
    }).input;
    expect(result?.payload).toMatchObject({ model: "bytedance/seedance-2-mini" });
    expect(input.prompt).toBe("scene @Video1 replace attress with @Image1");
    expect(input.prompt).not.toMatch(/@vid-/);
    expect(input.prompt).not.toMatch(/@img-/);
    expect(input.reference_image_urls).toEqual(["@img-actress"]);
    expect(input.reference_video_urls).toEqual(["@vid-full-notats"]);
  });

  it("rewrites free-form wan video-edit @slugs to natural language", () => {
    const result = translateToolPayload("generate_wan27_videoedit_video", {
      prompt: "make @vid-clip match @img-style",
      video_slug: "vid-clip",
      image_slug: "img-style",
    });

    expect((result?.payload as { input: { prompt: string } }).input.prompt).toBe(
      "make the source video match reference image 1",
    );
  });
});
