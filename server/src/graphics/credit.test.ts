import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, NotebookCell } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { sourceCredit } from "./credit.js";

const TIKTOK = {
  origin: "download",
  source_url: "https://vm.tiktok.com/ZMabc123/",
  webpage_url: "https://www.tiktok.com/@pomkondeena/video/7432100000000000000",
  platform: "TikTok",
  uploader: "pomkondeena",
  title: "red light",
  width: 1080,
  height: 1920,
  duration: 12,
};

describe("sourceCredit", () => {
  let root: string;
  let engine: Engine;
  let placed = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-graphics-credit-"));
    engine = createEngineForTest(root);
  });

  afterAll(async () => {
    closeEngineForTest(root, engine);
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function video(original: Record<string, unknown> | null): Promise<string> {
    const created = await engine.artifacts.create("video", "clip");
    if (!created.ok) throw new Error(created.error.message);
    if (original) {
      const written = await engine.metadata.artifacts.write(created.value.artifactId, "original", original);
      if (!written.ok) throw new Error(written.error.message);
    }
    return created.value.artifactId;
  }

  async function notebook(cells: NotebookCell[]): Promise<void> {
    const created = await engine.notebooks.create(`Credit ${placed}`);
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.notebooks.write({ ...created.value, cells });
    if (!written.ok) throw new Error(written.error.message);
  }

  function cell(outputArtifactId: string, inputs: Record<string, unknown> = {}): NotebookCell {
    const slot = { row: Math.floor(placed / 8), column: placed % 8 };
    placed += 1;
    return engine.notebooks.createCell({ type: "video", slot, outputArtifactId, inputs });
  }

  it("names the TikTok uploader of a downloaded video", async () => {
    const source = await video(TIKTOK);
    expect(await sourceCredit(engine, source)).toEqual({
      text: "TikTok/@pomkondeena",
      platform: "TikTok",
      handle: "pomkondeena",
      url: TIKTOK.webpage_url,
    });
  });

  it("follows a trimmed clip and a copy made from it back to the download", async () => {
    const source = await video(TIKTOK);
    const clip = await video({ width: 1080, height: 1920, duration: 3, fps: 30, hasAudio: true });
    const copy = await video({ origin: "watermark" });
    const sourceCell = cell(source, { sourceOperation: "download_video" });
    const clipCell = cell(clip, { sourceCellId: sourceCell.id, keepRanges: [{ startSeconds: 2, endSeconds: 5 }] });
    await notebook([sourceCell, clipCell, cell(copy, { sourceOperation: "caption_video", sourceArtifactId: clip })]);
    expect((await sourceCredit(engine, clip))?.text).toBe("TikTok/@pomkondeena");
    expect((await sourceCredit(engine, copy))?.text).toBe("TikTok/@pomkondeena");
  });

  it("returns null for a generated or uploaded video and for a chain that loops", async () => {
    const generated = await video({ origin: "generate_video", model: "kie:veo-3", width: 720, height: 1280 });
    expect(await sourceCredit(engine, generated)).toBeNull();
    expect(await sourceCredit(engine, await video({ origin: "upload", filename: "phone.mov" }))).toBeNull();
    expect(await sourceCredit(engine, await video(null))).toBeNull();
    const first = await video({});
    const second = await video({});
    await notebook([cell(first, { sourceArtifactId: second }), cell(second, { source_asset_id: first })]);
    expect(await sourceCredit(engine, first)).toBeNull();
  });

  it("stops after eight steps back", async () => {
    const source = await video(TIKTOK);
    const chain = [source];
    for (let step = 0; step < 9; step += 1) chain.push(await video({}));
    await notebook(chain.slice(1).map((id, index) => cell(id, { sourceArtifactId: chain[index] })));
    expect((await sourceCredit(engine, chain[8]))?.text).toBe("TikTok/@pomkondeena");
    expect(await sourceCredit(engine, chain[9])).toBeNull();
  });

  it.each([
    ["an X status link", { webpage_url: "https://x.com/NASA/status/1850000000000000000", platform: "twitter", uploader: "NASA Space" }, "X/@NASA"],
    ["a YouTube channel handle", { webpage_url: "https://www.youtube.com/@veritasium/shorts", platform: "youtube:tab", uploader: "Veritasium" }, "YouTube/@veritasium"],
    ["a TikTok short link with the uploader", { source_url: "https://vt.tiktok.com/ZSabc/", platform: "TikTok", uploader: "@kondee" }, "TikTok/@kondee"],
    ["an Instagram reel under its account", { webpage_url: "https://www.instagram.com/thai.street/reel/C9abc/", platform: "Instagram", uploader: "Thai Street" }, "Instagram/@thai.street"],
    ["a source prefix without a link", { platform: "tt", uploader: "pomkondeena" }, "TikTok/@pomkondeena"],
  ])("reads %s", async (_name, original, text) => {
    expect((await sourceCredit(engine, await video(original)))?.text).toBe(text);
  });

  it.each([
    ["an Instagram reel without an account handle", { webpage_url: "https://www.instagram.com/reel/C9abc/", platform: "Instagram", uploader: "Thai Street" }],
    ["an unknown site", { webpage_url: "https://example.com/watch/1", platform: "generic", uploader: "someone" }],
    ["a YouTube watch link with a display name", { webpage_url: "https://www.youtube.com/watch?v=abc", platform: "youtube", uploader: "Some Channel" }],
  ])("returns null for %s", async (_name, original) => {
    expect(await sourceCredit(engine, await video(original))).toBeNull();
  });
});
