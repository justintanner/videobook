import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { VideocityFs } from "videocity-engine";
import { createFsForTest } from "../fs.js";
import type { JobHandlerContext } from "../queue.js";
import { parseSegments } from "../remotion/subtitles/segments.js";
import { computeSourceTextHash } from "./_translate-transcript.js";
import { runTranslateTranscript } from "./translate-transcript.js";

const testCtx: JobHandlerContext = {
  setLease: () => {},
  getOwnerId: () => "test-owner",
};

describe("runTranslateTranscript", () => {
  let fs: VideocityFs;
  let tempDir: string;
  const projectSlug = "test-proj";
  const originalKey = process.env.OPENAI_API_KEY;

  beforeEach(async () => {
    delete process.env.OPENAI_API_KEY;
    tempDir = await mkdtemp(join(tmpdir(), "videocity-translate-test-"));
    fs = createFsForTest(tempDir);
    const project = await fs.createProject(projectSlug);
    if (!project.ok) throw new Error(project.error.message);
  });

  afterEach(async () => {
    if (originalKey) {
      process.env.OPENAI_API_KEY = originalKey;
    } else {
      delete process.env.OPENAI_API_KEY;
    }
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  const transcriptJson = {
    language_code: "zho",
    words: [
      { text: "喝牛奶。", start: 0, end: 1.2, type: "word" },
      { text: "谢谢妈妈。", start: 1.4, end: 2.2, type: "word" },
    ],
  };

  async function createTranscribedAsset(): Promise<string> {
    const created = await fs.createAsset("vid", "clip", projectSlug);
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.assetId;
    const write = await fs.writeFile(assetId, "elevenlabs.json", JSON.stringify(transcriptJson), projectSlug);
    if (!write.ok) throw new Error(write.error.message);
    return assetId;
  }

  it("throws when the asset has no transcript", async () => {
    const created = await fs.createAsset("vid", "clip", projectSlug);
    if (!created.ok) throw new Error(created.error.message);
    await expect(runTranslateTranscript(fs, {
      type: "translate_transcript",
      assetId: created.value.assetId,
      projectSlug,
      targetLanguage: "en",
    }, testCtx)).rejects.toThrow(/No transcript/);
  });

  it("skips when the target language matches the detected source", async () => {
    const assetId = await createTranscribedAsset();
    const result = await runTranslateTranscript(fs, {
      type: "translate_transcript",
      assetId,
      projectSlug,
      targetLanguage: "zh",
    }, testCtx);
    expect(result).toEqual({ success: true, targetLanguage: "zh", skipped: "matches-source" });
  });

  it("serves a cached sidecar whose hash matches the transcript without calling the LLM", async () => {
    const assetId = await createTranscribedAsset();
    // OPENAI_API_KEY is unset: reaching translation would throw, so success proves the cache path.
    const sidecar = {
      sourceTextHash: computeSourceTextHash(parseSegments(transcriptJson)),
      targetLanguage: "en",
      segments: [{ start: 0, end: 2.2, text: "Drink the milk. Thanks mom.", words: [] }],
    };
    const write = await fs.writeFile(assetId, "elevenlabs.en.json", JSON.stringify(sidecar), projectSlug);
    if (!write.ok) throw new Error(write.error.message);

    const result = await runTranslateTranscript(fs, {
      type: "translate_transcript",
      assetId,
      projectSlug,
      targetLanguage: "en",
    }, testCtx);
    expect(result).toEqual({ success: true, targetLanguage: "en", cached: true });
  });

  it("re-translates when the cached sidecar hash no longer matches", async () => {
    const assetId = await createTranscribedAsset();
    const stale = {
      sourceTextHash: "000000000000",
      targetLanguage: "en",
      segments: [{ start: 0, end: 2.2, text: "stale", words: [] }],
    };
    const write = await fs.writeFile(assetId, "elevenlabs.en.json", JSON.stringify(stale), projectSlug);
    if (!write.ok) throw new Error(write.error.message);

    // Translation is attempted (not served from cache), which fails fast on the missing key.
    await expect(runTranslateTranscript(fs, {
      type: "translate_transcript",
      assetId,
      projectSlug,
      targetLanguage: "en",
    }, testCtx)).rejects.toThrow(/OPENAI_API_KEY/);
  });
});
