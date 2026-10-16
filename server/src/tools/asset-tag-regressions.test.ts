import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEngine, type Engine } from "videobook-engine";
import { assetTagDefs } from "./asset-tags.js";
import { assetTagSummary, matchesTagFilter, type AssetTagSummary } from "../asset-tags.js";

describe("canonical tag boundaries", () => {
  let root: string;
  let engine: Engine;
  let assetId: string;
  let sourceHash: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "tag-boundaries-"));
    engine = createEngine({ durableWrites: false, rootDir: root, initialBookName: "Tag boundaries" });
    await engine.ready;
    const created = await engine.artifacts.create({ kind: "image" });
    if (!created.ok) throw new Error(created.error.message);
    assetId = created.value.artifactId;
    expect((await engine.files.write(assetId, "original.png", "image")).ok).toBe(true);
    const files = await engine.files.manifest(assetId);
    if (!files.ok) throw new Error(files.error.message);
    sourceHash = files.value.files[0]!.objectHash;
  });

  afterEach(async () => {
    engine.close();
    await rm(root, { recursive: true, force: true });
  });

  async function invoke(name: string, args: Record<string, unknown>) {
    const def = assetTagDefs(engine).find((entry) => entry.name === name)!;
    const response = await def.handler({ book_id: engine.book.get().bookId, asset_id: assetId, ...args });
    expect(response.isError).toBeUndefined();
    const text = response.content.find((item) => item.type === "text");
    if (!text || text.type !== "text") throw new Error("Missing response");
    return JSON.parse(text.text) as { tags: AssetTagSummary; suggestions: Array<{ key: string; assets: number }> };
  }

  async function automatic(label: string) {
    expect((await engine.tags.automatic.replace({
      artifactId: assetId, sourceHash, generator: "test", extractorVersion: "test", tags: [{ facet: "editing", label }],
    })).ok).toBe(true);
  }

  it("infers categories and converges manual aliases with automatic tags and filters", async () => {
    await automatic("close-up");
    for (const label of ["closeup", "close up", "tight shot"]) {
      const { tags } = await invoke("edit_asset_tag", { op: "add", label });
      expect(tags.effective.map((tag) => `${tag.facet}/${tag.key}`)).toEqual(["editing/close-up"]);
      expect(tags.effective[0]!.origin).toBe("manual");
      expect(matchesTagFilter(tags, { all: [{ label }] })).toBe(true);
      expect(matchesTagFilter(tags, { all: [{ facet: "editing", label }] })).toBe(true);
      const suggestions = await invoke("suggest_asset_tags", { prefix: label });
      expect(suggestions.suggestions).toEqual([expect.objectContaining({ key: "close-up", assets: 1 })]);
    }
    expect((await invoke("edit_asset_tag", { op: "add", label: "kitchen" })).tags.effective)
      .toContainEqual(expect.objectContaining({ facet: "places", key: "kitchen" }));
    expect((await invoke("edit_asset_tag", { op: "add", label: "Client approved" })).tags.effective)
      .toContainEqual(expect.objectContaining({ facet: "custom", key: "client approved" }));
    expect((await invoke("edit_asset_tag", { op: "remove", label: "close up" })).tags.effective.some((tag) => tag.facet === "editing"))
      .toBe(false);
    expect((await invoke("edit_asset_tag", { op: "restore", label: "closeup" })).tags.effective)
      .toContainEqual(expect.objectContaining({ key: "close-up", origin: "automatic" }));
  });

  it("keeps old assignments and dismissals usable across alias spellings", async () => {
    expect((await engine.tags.add(assetId, { facet: "editing", label: "closeup" })).ok).toBe(true);
    await automatic("close-up");
    const before = engine.tags.read(assetId);
    if (!before.ok) throw new Error(before.error.message);
    expect(assetTagSummary(before.value).effective).toHaveLength(1);
    expect((await invoke("suggest_asset_tags", { prefix: "closeu" })).suggestions)
      .toEqual([expect.objectContaining({ key: "close-up", assets: 1 })]);
    const removed = await invoke("edit_asset_tag", { op: "remove", label: "close-up" });
    expect(removed.tags.effective).toEqual([]);
    expect(removed.tags.dismissed).toHaveLength(1);
    await automatic("closeup");
    const state = engine.tags.read(assetId);
    if (!state.ok) throw new Error(state.error.message);
    expect(assetTagSummary(state.value).effective).toEqual([]);
    expect((await invoke("edit_asset_tag", { op: "restore", label: "close up" })).tags.effective)
      .toEqual([expect.objectContaining({ key: "close-up", origin: "automatic" })]);
    expect((await engine.tags.remove(assetId, { facet: "editing", label: "closeup" })).ok).toBe(true);
    await automatic("close-up");
    const legacy = engine.tags.read(assetId);
    if (!legacy.ok) throw new Error(legacy.error.message);
    expect(assetTagSummary(legacy.value).effective).toEqual([]);
    expect((await invoke("edit_asset_tag", { op: "add", label: "closeup" })).tags.effective)
      .toEqual([expect.objectContaining({ key: "close-up", origin: "manual" })]);
  });
});
