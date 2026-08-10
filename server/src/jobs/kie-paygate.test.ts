import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalHash, parseOtp, verifyOtp } from "@apicity/cost";
import { ensurePaygateSecret, KIE_PAYGATE_DOT_PATH, mintKieOtp } from "./kie-paygate.js";
import { buildGrokImagineT2vVideoPayload } from "../payload-builders.js";

describe("kie paygate", () => {
  let tempDir: string;
  let previousSecret: string | undefined;
  let previousSecretPath: string | undefined;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-kie-paygate-test-"));
    previousSecret = process.env.APICITY_PAYGATE_SECRET;
    previousSecretPath = process.env.APICITY_PAYGATE_SECRET_PATH;
    delete process.env.APICITY_PAYGATE_SECRET;
    delete process.env.APICITY_PAYGATE_SECRET_PATH;
  });

  afterEach(async () => {
    if (previousSecret === undefined) delete process.env.APICITY_PAYGATE_SECRET;
    else process.env.APICITY_PAYGATE_SECRET = previousSecret;
    if (previousSecretPath === undefined) delete process.env.APICITY_PAYGATE_SECRET_PATH;
    else process.env.APICITY_PAYGATE_SECRET_PATH = previousSecretPath;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("creates a configured secret and mints a request-bound OTP", async () => {
    const secretPath = join(tempDir, "paygate-secret");
    process.env.APICITY_PAYGATE_SECRET_PATH = secretPath;

    const secret = ensurePaygateSecret();
    const persistedSecret = await readFile(secretPath, "utf8");
    expect(persistedSecret.trim()).toBe(secret);
    expect(process.env.APICITY_PAYGATE_SECRET_PATH).toBe(secretPath);

    const request = {
      model: "grok-imagine/text-to-image" as const,
      input: { prompt: "paygate test" },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);
    const result = verifyOtp({
      nowSeconds: Math.floor(Date.now() / 1000),
      secret,
      expected: {
        provider: "kie",
        method: "POST",
        dotPath: KIE_PAYGATE_DOT_PATH,
      },
      payloadHash: canonicalHash(request),
      otp,
      isJtiConsumed: () => false,
    });

    expect(result.ok).toBe(true);
    expect(parsed.payload).toMatchObject({
      v: 1,
      provider: "kie",
      method: "POST",
      dotPath: KIE_PAYGATE_DOT_PATH,
      requestHash: canonicalHash(request),
    });
    expect(parsed.payload.exp - parsed.payload.iat).toBe(60);
  });

  it("mints a bounded OTP for a bare Grok text-to-video payload", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    const request = buildGrokImagineT2vVideoPayload({
      prompt: "a quiet skyline",
    });

    expect(request.input).toMatchObject({
      duration: 6,
      resolution: "480p",
    });
    expect(() => mintKieOtp(request, 60)).not.toThrow();
  });

  it("rejects a grok-imagine/extend request with no resolution hint as unbounded", () => {
    // grok-imagine/extend keys its rate off (extend_times, resolution). The kie
    // input schema carries only task_id + extend_times, so without a resolution
    // hint the lookup misses ("variant '6'") and the estimate is unbounded.
    const request = {
      model: "grok-imagine/extend" as const,
      input: {
        task_id: "task-123",
        prompt: "extend it",
        extend_at: "4",
        extend_times: "6" as const,
      },
    };
    expect(() => mintKieOtp(request, 60)).toThrow(/cost estimate is not bounded/);
  });

  it("mints a bounded OTP for a grok-imagine/extend request with a top-level resolution hint", async () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const request = {
      model: "grok-imagine/extend" as const,
      resolution: "480p" as const,
      input: {
        task_id: "task-123",
        prompt: "extend it",
        extend_at: "4",
        extend_times: "6" as const,
      },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });

  it("rejects a happyhorse/video-edit request with no duration hint as unbounded", () => {
    // happyhorse/video-edit prices per second but its kie input schema carries
    // no duration field (output length = source video). Without an out-of-band
    // cost hint the units derivation fails and the estimate is unbounded.
    const request = {
      model: "happyhorse/video-edit" as const,
      input: {
        prompt: "swap the characters",
        video_url: "https://kie.example/source.mp4",
        resolution: "1080p" as const,
      },
    };
    expect(() => mintKieOtp(request, 60)).toThrow(/cost estimate is not bounded/);
  });

  it("mints a bounded OTP for a happyhorse/video-edit request with an out-of-band duration hint", async () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    // The wire payload carries only documented fields — no top-level duration.
    const request = {
      model: "happyhorse/video-edit" as const,
      input: {
        prompt: "swap the characters",
        video_url: "https://kie.example/source.mp4",
        resolution: "1080p" as const,
      },
    };
    // The duration hint flows only to computeEstimate; the OTP-hashed request
    // is the documented payload verbatim, so the wire request hash matches.
    const otp = mintKieOtp(request, 60, KIE_PAYGATE_DOT_PATH, { duration: 9.97 });
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
    expect(parsed.payload.requestHash).not.toBe(canonicalHash({ ...request, duration: 9.97 }));
  });

  it("mints a bounded OTP for HappyHorse 1.1 requests now priced by @apicity/cost", () => {
    // @apicity/cost prices happyhorse-1-1/* directly; mintKieOtp admits
    // the request with a bounded estimate.
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const requests = [
      { model: "happyhorse-1-1/text-to-video" as const, input: { prompt: "a horse", resolution: "1080p" as const, aspect_ratio: "16:9" as const, duration: 5 } },
      { model: "happyhorse-1-1/image-to-video" as const, input: { image_urls: ["https://kie.example/first.png"], resolution: "1080p" as const, duration: 5 } },
      { model: "happyhorse-1-1/reference-to-video" as const, input: { prompt: "two characters", reference_image: ["https://kie.example/char.png"], resolution: "720p" as const, aspect_ratio: "9:16" as const, duration: 5 } },
    ];

    for (const request of requests) {
      const otp = mintKieOtp(request, 60);
      const parsed = parseOtp(otp);
      expect(parsed.payload.requestHash).toBe(canonicalHash(request));
    }
  });

  it("mints a bounded OTP for a Seedance 2 Mini request now priced by @apicity/cost", () => {
    // @apicity/cost prices bytedance/seedance-2-mini directly; mintKieOtp
    // admits the request with a bounded estimate.
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const request = {
      model: "bytedance/seedance-2-mini" as const,
      input: {
        prompt: "a tiny horse trotting",
        resolution: "720p" as const,
        aspect_ratio: "16:9" as const,
        duration: 15,
      },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });

  it("fails closed for Seedance 2.5 until @apicity/cost registers pricing", () => {
    const request = {
      model: "bytedance/seedance-2-5" as const,
      input: {
        prompt: "a continuous tracking shot",
        resolution: "720p" as const,
        duration: 30,
      },
    };

    expect(() => mintKieOtp(request, 60)).toThrow(
      /cost estimate is not bounded.*bytedance\/seedance-2-5/,
    );
  });

  // vc-3vn2: missing resolution + reference_video_urls → variant 'video' (unbounded).
  it("rejects Seedance 2 Mini with reference video but no resolution as unbounded", () => {
    const request = {
      model: "bytedance/seedance-2-mini" as const,
      input: {
        prompt: "scene continuity",
        reference_video_urls: ["https://kie.example/scene.mp4"],
        duration: 15,
      },
    };
    expect(() => mintKieOtp(request, 60)).toThrow(/cost estimate is not bounded.*variant 'video'/);
  });

  it("mints a bounded OTP for Seedance 2 Mini with video refs when resolution is set", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const request = {
      model: "bytedance/seedance-2-mini" as const,
      input: {
        prompt: "scene continuity",
        reference_video_urls: ["https://kie.example/scene.mp4"],
        resolution: "720p" as const,
        duration: 15,
      },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);
    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });

  it("mints a bounded OTP for a priced Gemini Omni text-to-video request", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const request = {
      model: "gemini-omni-video" as const,
      input: {
        prompt: "a sunset over the ocean",
        duration: "6" as const,
        aspect_ratio: "16:9" as const,
        resolution: "720p" as const,
      },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });

  it.each([
    {
      model: "omnihuman-1-5" as const,
      input: {
        image_url: "https://kie.example/portrait.png",
        audio_url: "https://kie.example/voice.mp3",
      },
    },
    {
      model: "volcengine/video-to-video-lip-sync" as const,
      input: {
        video_url: "https://kie.example/source.mp4",
        audio_url: "https://kie.example/voice.mp3",
        mode: "lite" as const,
      },
    },
  ])("rejects $model without a duration cost hint as unbounded", (request) => {
    expect(() => mintKieOtp(request, 60)).toThrow(/cost estimate is not bounded/);
  });

  it.each([
    {
      model: "omnihuman-1-5" as const,
      input: {
        image_url: "https://kie.example/portrait.png",
        audio_url: "https://kie.example/voice.mp3",
      },
    },
    {
      model: "volcengine/video-to-video-lip-sync" as const,
      input: {
        video_url: "https://kie.example/source.mp4",
        audio_url: "https://kie.example/voice.mp3",
        mode: "lite" as const,
      },
    },
  ])("mints a bounded OTP for $model with an out-of-band duration hint", (request) => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const otp = mintKieOtp(request, 60, KIE_PAYGATE_DOT_PATH, { duration: 8 });
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });

  it("mints a bounded OTP for Gemini Omni video-to-video after the v2v selector fix", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const request = {
      model: "gemini-omni-video" as const,
      input: {
        prompt: "extend the ocean sunset",
        duration: "6" as const,
        resolution: "720p" as const,
        video_list: [{ url: "https://kie.example/source.mp4", start: 0, ends: 4 }],
      },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });

  it("mints a bounded OTP for MiniMax H3 off the upstream rate table", () => {
    // @apicity/cost@0.8.8 prices minimax-h3/* per second by resolution tier
    // (docs/apicity-gaps.md §35), so the paygate bounds these payloads with no
    // local table. The OTP still hashes the documented payload verbatim.
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const requests = [
      { model: "minimax-h3/text-to-video" as const, input: { prompt: "a kitten", aspect_ratio: "9:16" as const, duration: 15, resolution: "768P" as const } },
      { model: "minimax-h3/image-to-video" as const, input: { prompt: "a kitten", first_frame_url: "https://kie.example/first.png", duration: 6 } },
      { model: "minimax-h3/reference-to-video" as const, input: { prompt: "a kitten", reference_image_urls: ["https://kie.example/ref.png"], duration: 15, resolution: "768P" as const } },
    ];

    for (const request of requests) {
      const otp = mintKieOtp(request, 60);
      expect(parseOtp(otp).payload.requestHash, request.model)
        .toBe(canonicalHash(request));
    }
  });

  it("mints a bounded OTP for grok-imagine/upscale off the floor rate", () => {
    // @apicity/cost@0.8.8 prices upscale at its lowest published tier ($0.05)
    // and warns that higher tiers exist — a floor, not an unbounded estimate,
    // so the paygate admits it.
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const request = {
      model: "grok-imagine/upscale" as const,
      input: { task_id: "task-123" },
    };
    const otp = mintKieOtp(request, 60);
    expect(parseOtp(otp).payload.requestHash).toBe(canonicalHash(request));
  });

  it("still rejects a MiniMax H3 request with no duration as unbounded", () => {
    // The upstream per-second rate needs a duration to derive units; a payload
    // without one must fail closed rather than mint against a zero estimate.
    const request = {
      model: "minimax-h3/text-to-video" as const,
      input: { prompt: "a kitten", aspect_ratio: "9:16" as const, resolution: "768P" as const },
    };
    expect(() => mintKieOtp(request, 60)).toThrow(/cost estimate is not bounded/);
  });

  it("rejects a kling-3.0/motion-control request with no duration hint as unbounded", () => {
    // kling-3.0/motion-control prices per second but its kie input
    // schema carries no duration field (output length = motion video). Without
    // an out-of-band cost hint the units derivation fails and the estimate is
    // unbounded.
    const request = {
      model: "kling-3.0/motion-control" as const,
      input: {
        input_urls: ["https://kie.example/character.png"],
        video_urls: ["https://kie.example/motion.mp4"],
        mode: "720p" as const,
      },
    };
    expect(() => mintKieOtp(request, 60)).toThrow(/cost estimate is not bounded/);
  });

  it("mints a bounded OTP for a kling-3.0/motion-control request with an out-of-band duration hint", async () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const request = {
      model: "kling-3.0/motion-control" as const,
      input: {
        input_urls: ["https://kie.example/character.png"],
        video_urls: ["https://kie.example/motion.mp4"],
        mode: "720p" as const,
      },
    };
    const otp = mintKieOtp(request, 60, KIE_PAYGATE_DOT_PATH, { duration: 6.4 });
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
    expect(parsed.payload.requestHash).not.toBe(canonicalHash({ ...request, duration: 6.4 }));
  });
});
