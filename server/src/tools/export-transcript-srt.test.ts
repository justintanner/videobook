import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { exportTranscriptSrtDef } from "./export-transcript-srt.js";

const fixture = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), "../fixtures/elevenlabs-transcript.json"),
  "utf8",
);

type TextContent = Array<{ type: string; text: string }>;

describe("export_transcript_srt", () => {
  let root: string | undefined;
  let downloads: string | undefined;

  afterEach(async () => {
    if (root) {
      const engine = createEngineForTest(root);
      closeEngineForTest(root, engine);
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
      root = undefined;
    }
    if (downloads) {
      await rm(downloads, { recursive: true, force: true, maxRetries: 3 });
      downloads = undefined;
    }
  });

  async function setup() {
    root = await mkdtemp(join(tmpdir(), "export-srt-"));
    downloads = await mkdtemp(join(tmpdir(), "export-srt-downloads-"));
    const engine = createEngineForTest(root);
    const created = await engine.artifacts.create("video", "greeting clip");
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.write(
      created.value.artifactId,
      "original.mp4",
      Buffer.from("fake-video"),
    );
    if (!written.ok) throw new Error(written.error.message);
    return { engine, artifactId: created.value.artifactId, bookId: engine.book.get().bookId };
  }

  it("writes a collision-avoiding SRT into the downloads directory", async () => {
    const { engine, artifactId, bookId } = await setup();
    const sidecar = await engine.files.write(artifactId, "elevenlabs.json", fixture);
    if (!sidecar.ok) throw new Error(sidecar.error.message);
    await writeFile(join(downloads!, "greeting clip.srt"), "already here", "utf8");

    const result = await exportTranscriptSrtDef(engine).handler({
      asset_id: artifactId,
      book_id: bookId,
      downloads_dir: downloads,
    });
    expect(result.isError).toBeFalsy();
    const payload = JSON.parse((result.content as TextContent)[0]!.text) as {
      status: string;
      path: string;
    };
    expect(payload.status).toBe("exported");
    expect(payload.path).toBe(join(downloads!, "greeting clip (2).srt"));
    const srt = await readFile(payload.path, "utf8");
    expect(srt).toMatch(/^1\n00:00:00,000 --> /);
    expect(srt).toContain("Hello");
    const original = await readFile(join(downloads!, "greeting clip.srt"), "utf8");
    expect(original).toBe("already here");
  });

  it("errors without writing a file when only a gpt-4o transcript exists", async () => {
    const { engine, artifactId, bookId } = await setup();
    const written = await engine.files.write(
      artifactId,
      ".analysis.gpt4otrans.json",
      JSON.stringify({
        text: "This is a plain text transcript with enough words to pass quality checks.",
      }),
    );
    if (!written.ok) throw new Error(written.error.message);

    const result = await exportTranscriptSrtDef(engine).handler({
      asset_id: artifactId,
      book_id: bookId,
      downloads_dir: downloads,
    });
    expect(result.isError).toBe(true);
    expect((result.content as TextContent)[0]!.text).toMatch(/word-timed/i);
    expect((result.content as TextContent)[0]!.text).toMatch(/gpt-4o/i);
    const listing = await import("node:fs/promises").then((fs) => fs.readdir(downloads!));
    expect(listing).toEqual([]);
  });
});
