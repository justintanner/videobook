import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { z } from "zod";
import { createEngine, type Engine } from "videobook-engine";
import { abortActiveBookJobsForTests, pauseBookQueueForTests, queue, setEngineRoot } from "../queue.js";
import { buildSeedance25Schema, generateSeedance25VideoDef } from "./generate-seedance25-video.js";

describe("buildSeedance25Schema", () => {
  it("exposes every Apicity 0.10.2 Seedance 2.5 option", () => {
    const schema = buildSeedance25Schema();

    expect(Object.keys(schema)).toEqual([
      "book_id",
      "prompt",
      "first_frame_ref",
      "last_frame_ref",
      "image_refs",
      "video_refs",
      "audio_refs",
      "return_last_frame",
      "generate_audio",
      "resolution",
      "aspect_ratio",
      "duration",
      "output_format",
      "web_search",
      "nsfw_checker",
      "replace_audio_with",
      "_provider",
    ]);
    expect(schema.prompt.safeParse(undefined).success).toBe(true);
    expect(schema.prompt.safeParse("x".repeat(30_000)).success).toBe(true);
    expect(schema.prompt.safeParse("x".repeat(30_001)).success).toBe(false);
    expect(schema.image_refs.safeParse(Array.from({ length: 30 }, (_, index) => `@img-${index}`)).success).toBe(true);
    expect(schema.image_refs.safeParse(Array.from({ length: 31 }, (_, index) => `@img-${index}`)).success).toBe(false);
    expect(schema.video_refs.safeParse(Array.from({ length: 10 }, (_, index) => `@vid-${index}`)).success).toBe(true);
    expect(schema.video_refs.safeParse(Array.from({ length: 11 }, (_, index) => `@vid-${index}`)).success).toBe(false);
    expect(schema.audio_refs.safeParse(Array.from({ length: 10 }, (_, index) => `@aud-${index}`)).success).toBe(true);
    expect(schema.audio_refs.safeParse(Array.from({ length: 11 }, (_, index) => `@aud-${index}`)).success).toBe(false);
    expect(schema.duration.safeParse("-1").success).toBe(true);
    expect(schema.duration.safeParse("4").success).toBe(true);
    expect(schema.duration.safeParse("30").success).toBe(true);
    expect(schema.duration.safeParse("31").success).toBe(false);
    expect(schema.resolution.safeParse("480p").success).toBe(true);
    expect(schema.resolution.safeParse("720p").success).toBe(true);
    expect(schema.resolution.safeParse("1080p").success).toBe(true);
    expect(schema.resolution.safeParse("4k").success).toBe(false);
    expect(schema.aspect_ratio.safeParse("adaptive").success).toBe(true);
    expect(schema.output_format.safeParse("mp4").success).toBe(true);
    expect(schema.output_format.safeParse("mov").success).toBe(true);
    expect(schema.output_format.safeParse("webm").success).toBe(false);
    expect(schema.return_last_frame.safeParse(true).success).toBe(true);
    expect(schema.generate_audio.safeParse(false).success).toBe(true);
    expect(schema.web_search.safeParse(true).success).toBe(true);
    expect(schema.nsfw_checker.safeParse(false).success).toBe(true);
  });
});

describe("Seedance 2.5 queued frame settings", () => {
  let engine: Engine | undefined;
  let rootDir = "";

  afterEach(async () => {
    await abortActiveBookJobsForTests();
    await queue.stop();
    await engine?.close();
    if (rootDir) await rm(rootDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it.each(["first", "pair", "text", "reference"])("queues the supported aspect ratio for %s input", async (mode) => {
    rootDir = await mkdtemp(join(tmpdir(), "videobook-seedance25-"));
    engine = createEngine({ rootDir, initialBookName: "seedance-frames", durableWrites: false });
    await engine.ready;
    const bookId = engine.book.get().bookId;
    await setEngineRoot(rootDir, engine);
    await pauseBookQueueForTests(bookId);
    const source = await engine.artifacts.create("image", "Original source");
    if (!source.ok) throw new Error(source.error.message);
    const sourceId = source.value.artifactId;
    const bytes = await sharp({ create: { width: 30, height: 20, channels: 3, background: "green" } }).png().toBuffer();
    const written = await engine.files.write(sourceId, "original.png", bytes);
    if (!written.ok) throw new Error(written.error.message);
    const previousKey = process.env.KIE_API_KEY;
    process.env.KIE_API_KEY = "test-key";
    try {
      const definition = generateSeedance25VideoDef(engine);
      const result = await definition.handler(z.object(definition.schema).parse({
        book_id: bookId, prompt: "Pan across the garden", aspect_ratio: "9:16",
        ...(mode === "first" || mode === "pair" ? { first_frame_ref: `@${sourceId}` } : {}),
        ...(mode === "pair" ? { last_frame_ref: `@${sourceId}` } : {}),
        ...(mode === "reference" ? { image_refs: [`@${sourceId}`] } : {}),
      }));
      expect(result.isError, result.content[0]?.text).not.toBe(true);
      const jobs = engine.jobs.queue.list({ type: "generate_seedance25_video" });
      expect(jobs).toHaveLength(1);
      expect(jobs[0]?.state).toBe("queued");
      expect(jobs[0]?.payload.aspect_ratio).toBe(mode === "first" || mode === "pair" ? "adaptive" : "9:16");
      if (mode === "first" || mode === "pair") {
        expect(jobs[0]?.payload.firstFrame).toEqual({ assetId: sourceId, filename: "original.png" });
      }
      if (mode === "pair") expect(jobs[0]?.payload.lastFrame).toEqual(jobs[0]?.payload.firstFrame);
      const original = await engine.files.read(sourceId, "original.png");
      if (!original.ok) throw new Error(original.error.message);
      expect(original.value).toEqual(bytes);
    } finally {
      if (previousKey === undefined) delete process.env.KIE_API_KEY;
      else process.env.KIE_API_KEY = previousKey;
    }
  });
});
