import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import {
  readAssetTranscriptSources,
  readTranscriptSidecarText,
} from "./transcript-projection.js";

const timedJson = {
  language_code: "eng",
  transcription_id: "scribe-should-not-ship",
  text: "Hello world",
  words: [
    { text: "Hello", start: 0, end: 0.5, type: "word", speaker_id: "spk_0" },
    { text: " ", start: 0.5, end: 0.6, type: "spacing", speaker_id: null },
    { text: "world", start: 0.6, end: 1, type: "word", speaker_id: "spk_0" },
  ],
};

const plainJson = {
  text: "This is a plain text transcript with enough words to pass quality checks.",
};

describe("readAssetTranscriptSources", () => {
  let root: string | undefined;

  afterEach(async () => {
    if (!root) return;
    const engine = createEngineForTest(root);
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    root = undefined;
  });

  async function createVideo() {
    root = await mkdtemp(join(tmpdir(), "transcript-sources-"));
    const engine = createEngineForTest(root);
    const created = await engine.artifacts.create("video", "clip");
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(
      created.value.artifactId,
      "original.mp4",
      Buffer.from("fake-video"),
    );
    if (!written.ok) throw new Error(written.error.message);
    return { engine, artifactId: created.value.artifactId };
  }

  it("returns both sources independently without raw sidecar JSON", async () => {
    const { engine, artifactId } = await createVideo();
    const writes = await Promise.all([
      engine.files.write(artifactId, "elevenlabs.json", JSON.stringify(timedJson)),
      engine.files.write(artifactId, ".analysis.gpt4otrans.json", JSON.stringify(plainJson)),
    ]);
    for (const write of writes) {
      if (!write.ok) throw new Error(write.error.message);
    }
    const manifest = await engine.files.manifest(artifactId, {
      includeDotfiles: true,
    });
    if (!manifest.ok) throw new Error(manifest.error.message);

    const sources = await readAssetTranscriptSources(
      engine,
      artifactId,
      manifest.value.files,
    );

    expect(sources).toEqual({
      elevenlabs: {
        kind: "timed",
        language_code: "eng",
        text: "Hello world",
        word_count: 2,
        words: [
          { text: "Hello", start: 0, end: 0.5 },
          { text: "world", start: 0.6, end: 1 },
        ],
      },
      plain: {
        kind: "plain",
        language_code: null,
        text: plainJson.text,
        word_count: 13,
      },
    });
    expect(JSON.stringify(sources)).not.toContain("transcription_id");
    expect(JSON.stringify(sources)).not.toContain("scribe-should-not-ship");
  });

  it("projects ElevenLabs Thai letters as whole words", async () => {
    const { engine, artifactId } = await createVideo();
    const letters = (texts: string[], start: number) => texts.map((text, index) => ({ text, start: start + index * 0.25, end: start + (index + 1) * 0.25, type: "word" }));
    const thai = {
      language_code: "tha",
      text: "ฉันชอบ แมว",
      words: [
        ...letters(["ฉั", "น", "ช", "อ", "บ"], 0),
        { text: " ", start: 1.25, end: 1.25, type: "spacing" },
        ...letters(["แ", "ม", "ว"], 1.5),
      ],
    };
    const written = await engine.files.write(artifactId, "elevenlabs.json", JSON.stringify(thai));
    if (!written.ok) throw new Error(written.error.message);
    const sources = await readAssetTranscriptSources(engine, artifactId);
    expect(sources?.elevenlabs).toEqual({
      kind: "timed",
      language_code: "tha",
      text: "ฉันชอบ แมว",
      word_count: 3,
      words: [
        { text: "ฉัน", start: 0, end: 0.5 },
        { text: "ชอบ ", start: 0.5, end: 1.25 },
        { text: "แมว", start: 1.5, end: 2.25 },
      ],
    });
  });

  it("returns elevenlabs alone when the plain sidecar is missing", async () => {
    const { engine, artifactId } = await createVideo();
    const written = await engine.files.write(
      artifactId,
      "elevenlabs.json",
      JSON.stringify(timedJson),
    );
    if (!written.ok) throw new Error(written.error.message);
    const sources = await readAssetTranscriptSources(engine, artifactId);
    expect(sources?.elevenlabs?.kind).toBe("timed");
    expect(sources?.plain).toBeNull();
  });

  it("returns plain alone when elevenlabs.json is missing", async () => {
    const { engine, artifactId } = await createVideo();
    const written = await engine.files.write(
      artifactId,
      ".analysis.gpt4otrans.json",
      JSON.stringify(plainJson),
    );
    if (!written.ok) throw new Error(written.error.message);
    const sources = await readAssetTranscriptSources(engine, artifactId);
    expect(sources?.elevenlabs).toBeNull();
    expect(sources?.plain?.kind).toBe("plain");
  });

  it("returns null when neither sidecar exists", async () => {
    const { engine, artifactId } = await createVideo();
    expect(await readAssetTranscriptSources(engine, artifactId)).toBeNull();
  });

  it("skips sidecar reads when the supplied manifest has none", async () => {
    const { engine, artifactId } = await createVideo();
    const manifest = await engine.files.manifest(artifactId, {
      includeDotfiles: true,
    });
    if (!manifest.ok) throw new Error(manifest.error.message);
    const originalRead = engine.files.read.bind(engine.files);
    let reads = 0;
    engine.files.read = (async (...args: Parameters<typeof originalRead>) => {
      reads += 1;
      return originalRead(...args);
    }) as typeof engine.files.read;
    expect(await readAssetTranscriptSources(
      engine,
      artifactId,
      manifest.value.files,
    )).toBeNull();
    expect(reads).toBe(0);
  });

  it("loads untouched sidecar text on demand", async () => {
    const { engine, artifactId } = await createVideo();
    const raw = JSON.stringify(timedJson, null, 2);
    const written = await engine.files.write(artifactId, "elevenlabs.json", raw);
    if (!written.ok) throw new Error(written.error.message);
    const sidecar = await readTranscriptSidecarText(engine, artifactId);
    expect(sidecar).toEqual({
      source: "elevenlabs",
      file: "elevenlabs.json",
      text: raw,
    });
  });

  it("selects an explicit sidecar even when the other source exists", async () => {
    const { engine, artifactId } = await createVideo();
    const timedRaw = JSON.stringify(timedJson);
    const plainRaw = JSON.stringify(plainJson);
    const writes = await Promise.all([
      engine.files.write(artifactId, "elevenlabs.json", timedRaw),
      engine.files.write(artifactId, ".analysis.gpt4otrans.json", plainRaw),
    ]);
    for (const write of writes) {
      if (!write.ok) throw new Error(write.error.message);
    }

    expect(await readTranscriptSidecarText(engine, artifactId, "plain")).toEqual({
      source: "plain",
      file: ".analysis.gpt4otrans.json",
      text: plainRaw,
    });
    expect(await readTranscriptSidecarText(engine, artifactId, "elevenlabs")).toEqual({
      source: "elevenlabs",
      file: "elevenlabs.json",
      text: timedRaw,
    });
  });
});
