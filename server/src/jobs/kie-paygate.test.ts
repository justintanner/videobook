import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { canonicalHash, computeEstimate, parseOtp, verifyOtp } from "@apicity/cost";
import { createEngine, QUEUED_TASK_ID } from "videobook-engine";
import { Seedance25RequestSchema } from "@apicity/kie/zod";
import { configureLoggerForTests, resetLoggerForTests } from "../logger.js";
import {
  authorizeKiePaygate,
  ensurePaygateSecret,
  KIE_PAYGATE_DOT_PATH,
  mintKieOtp,
  submitQueuedKieTask,
} from "./kie-paygate.js";
import { assessKieRequestEstimate } from "./cost-estimate-assessment.js";
import { buildGrokImagineT2vVideoPayload } from "../payload-builders.js";
import { seedreamLayerDecompositionRequest } from "./image-subjects.js";

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

  it("repairs a persisted Seedance frame payload before authorizing a queued retry", async () => {
    const engine = createEngine({ rootDir: join(tempDir, "book"), initialBookName: "queued-frames", durableWrites: false });
    const previousKey = process.env.KIE_API_KEY;
    delete process.env.KIE_API_KEY;
    try {
      await engine.ready;
      const artifact = await engine.artifacts.create("video", "Failed frame generation");
      if (!artifact.ok) throw new Error(artifact.error.message);
      const artifactId = artifact.value.artifactId;
      const lease = await engine.jobs.artifactWork.begin(artifactId, {
        kind: "generate", ownerKind: "job", durationMs: 60_000,
      });
      if (!lease) throw new Error("Missing generation lease");
      const pending = await engine.jobs.pending.write({
        artifactId, taskId: QUEUED_TASK_ID, taskType: "seedance2_video", meta: {},
      }, lease.ownerId);
      if (!pending.ok || !pending.value) throw new Error("Missing queued task");
      const saved = Seedance25RequestSchema.parse({
        model: "bytedance/seedance-2-5",
        input: {
          prompt: "Animate the two frames",
          first_frame_url: "https://example.test/first.png",
          last_frame_url: "https://example.test/last.png",
          aspect_ratio: "9:16",
        },
      });
      await engine.metadata.artifacts.write(artifactId, "generation-payload", saved);
      await expect(submitQueuedKieTask(engine, pending.value.task)).rejects.toThrow(/KIE_API_KEY/);
      const result = await engine.metadata.artifacts.read(artifactId, "generation-payload");
      if (!result.ok) throw new Error(result.error.message);
      expect(result.value).toEqual({ ...saved, input: { ...saved.input, aspect_ratio: "adaptive" } });
      expect(Seedance25RequestSchema.safeParse(result.value).success).toBe(true);
      expect(saved.input.aspect_ratio).toBe("9:16");
      expect(await engine.jobs.pending.getOwner(artifactId, QUEUED_TASK_ID)).toBe(lease.ownerId);
    } finally {
      if (previousKey === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = previousKey;
      await engine.close();
    }
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

  it("mints a bounded OTP for a layer-decomposition request with an explicit size tier", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    // The rate table prices size 1K/1.5K/2K only; the upstream default "auto"
    // selects no rate, so request builders must always send a concrete tier.
    const request = seedreamLayerDecompositionRequest(
      "https://example.test/source.jpg",
      1920,
      1080,
    );
    expect(request.input.size).toBe("2K");
    expect(() => mintKieOtp(request, 60)).not.toThrow();

    const unbounded = {
      model: "seedream/5-pro-layer-decomposition" as const,
      input: {
        image_url: "https://example.test/source.jpg",
        size: "auto" as const,
      },
    };
    expect(() => mintKieOtp(unbounded, 60)).not.toThrow();
  });

  it("mints a request-bound OTP for a grok-imagine/extend request with no resolution hint", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    // grok-imagine/extend keys its rate off (extend_times, resolution). The kie
    // input schema carries only task_id + extend_times, so without a resolution
    // hint the lookup misses ("variant '6'") and the estimate is unbounded.
    const request = {
      model: "grok-imagine/extend" as const,
      input: {
        task_id: "task-123",
        prompt: "extend it",
        extend_at: 4,
        extend_times: "6" as const,
      },
    };
    const otp = mintKieOtp(request, 60);
    expect(parseOtp(otp).payload.requestHash).toBe(canonicalHash(request));
  });

  it("mints a bounded OTP for a grok-imagine/extend request with a top-level resolution hint", async () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";

    const request = {
      model: "grok-imagine/extend" as const,
      resolution: "480p" as const,
      input: {
        task_id: "task-123",
        prompt: "extend it",
        extend_at: 4,
        extend_times: "6" as const,
      },
    };
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });

  it("mints a request-bound OTP for a happyhorse/video-edit request with no duration hint", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
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
    const otp = mintKieOtp(request, 60);
    expect(parseOtp(otp).payload.requestHash).toBe(canonicalHash(request));
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

  it("mints a request-bound OTP for priced Seedance 2.5", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    const request = {
      model: "bytedance/seedance-2-5" as const,
      input: {
        prompt: "a continuous tracking shot",
        resolution: "720p" as const,
        duration: 30,
      },
    };
    const estimate = computeEstimate({ provider: "kie", payload: request });

    expect(estimate).toMatchObject({
      usd: 9.45,
      warnings: [],
    });
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });

  it("prices Seedance 2.5 1080p from the Apicity 0.13.0 rate table", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    const request = {
      model: "bytedance/seedance-2-5" as const,
      input: {
        prompt: "a continuous tracking shot",
        resolution: "1080p" as const,
        duration: 5,
        generate_audio: true,
      },
    };
    const estimate = computeEstimate({ provider: "kie", payload: request });

    expect(estimate.usd).toBeCloseTo(2.85);
    expect(estimate.warnings).toEqual([]);
    const otp = mintKieOtp(request, 60);
    const parsed = parseOtp(otp);

    expect(parsed.payload.requestHash).toBe(canonicalHash(request));
  });

  it("mints a bounded OTP for Seedance 2 Mini with reference video and no resolution", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    const request = {
      model: "bytedance/seedance-2-mini" as const,
      input: {
        prompt: "scene continuity",
        reference_video_urls: ["https://kie.example/scene.mp4"],
        duration: 15,
      },
    };
    const estimate = computeEstimate({
      provider: "kie",
      payload: request,
      costHints: { inputDurationSeconds: 5 },
    });
    expect(estimate.usd).toBeGreaterThan(0);
    expect(estimate.warnings).toEqual([]);
    const otp = mintKieOtp(request, 60);
    expect(parseOtp(otp).payload.requestHash).toBe(canonicalHash(request));
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
  ])("mints a request-bound OTP for $model without a duration cost hint", (request) => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    const otp = mintKieOtp(request, 60);
    expect(parseOtp(otp).payload.requestHash).toBe(canonicalHash(request));
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

  it("mints a request-bound OTP for grok-imagine/upscale without source/target resolutions", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    const request = {
      model: "grok-imagine/upscale" as const,
      input: { task_id: "task-123" },
    };
    const otp = mintKieOtp(request, 60);
    expect(parseOtp(otp).payload.requestHash).toBe(canonicalHash(request));
  });

  it("mints a request-bound OTP for a MiniMax H3 request with no duration", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    const request = {
      model: "minimax-h3/text-to-video" as const,
      input: { prompt: "a kitten", aspect_ratio: "9:16" as const, resolution: "768P" as const },
    };
    const otp = mintKieOtp(request as never, 60);
    expect(parseOtp(otp).payload.requestHash).toBe(canonicalHash(request));
  });

  it("mints a request-bound OTP for a kling-3.0/motion-control request with no duration hint", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
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
    const otp = mintKieOtp(request, 60);
    expect(parseOtp(otp).payload.requestHash).toBe(canonicalHash(request));
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

  it("mints a request-bound OTP for an unbounded Kling 3.0 Omni transformation", () => {
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    const request = {
      model: "kling-3.0-omni/transformation" as const,
      input: {
        prompt: "restyle the source clip as watercolor",
        image_urls: ["https://kie.example/style.png"],
        video_urls: ["https://kie.example/source.mp4"],
        aspect_ratio: "9:16" as const,
      },
    };
    const assessment = assessKieRequestEstimate(request);
    expect(assessment.available).toBe(false);
    const otp = mintKieOtp(request, 60);
    expect(parseOtp(otp).payload.requestHash).toBe(canonicalHash(request));
  });
});

describe("kie paygate advisory authorization", () => {
  let previousSecret: string | undefined;
  let previousSecretPath: string | undefined;
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-kie-authorize-"));
    previousSecret = process.env.APICITY_PAYGATE_SECRET;
    previousSecretPath = process.env.APICITY_PAYGATE_SECRET_PATH;
    process.env.APICITY_PAYGATE_SECRET = "test-secret";
    delete process.env.APICITY_PAYGATE_SECRET_PATH;
  });

  afterEach(async () => {
    resetLoggerForTests();
    if (previousSecret === undefined) delete process.env.APICITY_PAYGATE_SECRET;
    else process.env.APICITY_PAYGATE_SECRET = previousSecret;
    if (previousSecretPath === undefined) delete process.env.APICITY_PAYGATE_SECRET_PATH;
    else process.env.APICITY_PAYGATE_SECRET_PATH = previousSecretPath;
    await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("authorizes an unbounded Kling transformation and logs a sanitized warning", async () => {
    const engine = createEngine({ durableWrites: false, rootDir, initialBookName: "paygate" });
    await engine.ready;
    const warnings: string[] = [];
    configureLoggerForTests({
      level: "warn",
      sink: {
        error: () => undefined,
        warn: (...args: unknown[]) => {
          warnings.push(args.map(String).join(" "));
        },
        info: () => undefined,
        debug: () => undefined,
      },
    });
    const secretOtp = "otp_should_never_appear";
    const prompt = "restyle the source clip as watercolor";
    const mediaUrl = "https://kie.example/source.mp4";
    const request = {
      model: "kling-3.0-omni/transformation" as const,
      input: {
        prompt,
        image_urls: ["https://kie.example/style.png"],
        video_urls: [mediaUrl],
        aspect_ratio: "9:16" as const,
      },
    };
    try {
      const authorized = await authorizeKiePaygate(request, {
        engine,
        correlation: {
          bookId: engine.book.get().bookId,
          artifactId: "01900000-0000-7000-8000-000000000013",
          runId: "run-kling-omni",
          jobId: "job-kling-omni",
          tool: "kling30_omni_video",
          stage: "submit-kie",
        },
      });
      expect(authorized.assessment.available).toBe(false);
      expect(authorized.otp).toEqual(expect.any(String));
      expect(authorized.otp).not.toContain(secretOtp);
      expect(parseOtp(authorized.otp).payload.requestHash).toBe(canonicalHash(request));
      const combined = [
        ...warnings,
        ...engine.logs.read("generation-cost-estimate").map((line) => JSON.stringify(line)),
      ].join("\n");
      expect(combined).toContain("generation-cost-estimate");
      expect(combined).toContain("01900000-0000-7000-8000-000000000013");
      expect(combined).not.toContain("run-kling-omni");
      expect(combined).not.toContain("job-kling-omni");
      expect(combined).toContain("submit-kie");
      expect(combined).not.toContain(prompt);
      expect(combined).not.toContain(mediaUrl);
      expect(combined).not.toContain(authorized.otp);
      expect(combined).not.toContain("APICITY_PAYGATE_SECRET");
      expect(combined).not.toContain("test-secret");
    } finally {
      engine.close();
    }
  });
});
