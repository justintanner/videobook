import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalHash, parseOtp, verifyOtp } from "@apicity/cost";
import { ensurePaygateSecret, KIE_PAYGATE_DOT_PATH, mintKieOtp } from "./kie-paygate.js";

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
    // no duration field (output length = source video). Without a top-level
    // duration hint the units derivation fails and the estimate is unbounded.
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

  it("mints a bounded OTP for a happyhorse/video-edit request with a top-level duration hint", async () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const request = {
      model: "happyhorse/video-edit" as const,
      duration: 9.97,
      input: {
        prompt: "swap the characters",
        video_url: "https://kie.example/source.mp4",
        resolution: "1080p" as const,
      },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });

  it("mints a bounded OTP for HappyHorse 1.1 requests now priced by @apicity/cost", () => {
    // @apicity/cost@0.6.1 prices happyhorse-1-1/* directly (no longer a
    // COST_TABLE_PENDING_MODELS shim), so computeEstimate returns a bounded
    // estimate with no warnings and mintKieOtp admits the request.
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
    // @apicity/cost@0.6.1 prices bytedance/seedance-2-mini directly (no longer a
    // COST_TABLE_PENDING_MODELS shim), so computeEstimate returns a bounded
    // estimate with no warnings and mintKieOtp admits the request.
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

  it("admits a Gemini Omni Video request via the cost-table-pending shim", () => {
    // @apicity/cost@0.6.1 ships no slug/pricing for gemini-omni-video, so
    // computeEstimate returns $0 + a "not found" warning. The model is listed in
    // COST_TABLE_PENDING_MODELS, so mintKieOtp admits it and binds the request
    // hash instead of rejecting as unbounded.
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

  it("rejects a kling-3.0/motion-control request with no duration hint as unbounded", () => {
    // kling-3.0/motion-control prices per second but its kie input
    // schema carries no duration field (output length = motion video). Without a
    // top-level duration hint the units derivation fails and the estimate is
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

  it("mints a bounded OTP for a kling-3.0/motion-control request with a top-level duration hint", async () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const request = {
      model: "kling-3.0/motion-control" as const,
      duration: 6.4,
      input: {
        input_urls: ["https://kie.example/character.png"],
        video_urls: ["https://kie.example/motion.mp4"],
        mode: "720p" as const,
      },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });
});
