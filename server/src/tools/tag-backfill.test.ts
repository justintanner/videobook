import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { withBookContext } from "../book-context.js";
import { scopedEngine } from "../engine.js";
import { queue, setEngineRoot } from "../queue.js";
import { enqueueAssetTagging } from "../jobs/tag-asset.js";
import { readBackfillState, writeBackfillState } from "../tag-backfill-state.js";
import { readTaggingSettings } from "../tag-settings.js";
import { tagBackfillDefs } from "./tag-backfill.js";
import type { ToolDef } from "./tool-def.js";

const ANALYSIS_FILENAME = ".original.analysis.json";

const USABLE_ANALYSIS = {
  summary: "A cook works at a counter.",
  setting: "A domestic kitchen",
  subjects: ["one person"],
  tags: [],
  actions: [],
  scenes: [],
};

describe("tag backfill tools", () => {
  let tempDir: string;
  let engine: Engine;
  let bookId: string;
  let defs: Map<string, ToolDef>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-backfill-tools-"));
    engine = createEngineForTest(tempDir);
    await engine.ready;
    // The start action queues a real job, so the queue has to resolve this
    // book the way it does in the running server.
    await setEngineRoot(tempDir, engine);
    bookId = engine.book.get().bookId;
    defs = new Map(tagBackfillDefs(scopedEngine).map((def) => [def.name, def]));
  });

  afterEach(async () => {
    await queue.stop();
    closeEngineForTest(tempDir, engine);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  async function invoke(name: string, args: Record<string, unknown> = {}) {
    const def = defs.get(name);
    if (!def) throw new Error(`Missing tool ${name}`);
    return await withBookContext({ bookId, engine }, () =>
      def.handler({ book_id: bookId, ...args }));
  }

  function parse(result: { content: Array<{ text: string }>; isError?: true }) {
    expect(result.isError, result.content[0]?.text).toBeUndefined();
    return JSON.parse(result.content[0]!.text) as Record<string, unknown>;
  }

  async function makeVideo(withAnalysis: boolean): Promise<string> {
    const created = await engine.artifacts.create({ kind: "video" });
    if (!created.ok) throw new Error(created.error.message);
    const assetId = created.value.artifactId;
    const written = await engine.files.write(
      assetId,
      "original.mp4",
      Buffer.from(`bytes-${assetId}`),
    );
    if (!written.ok) throw new Error(written.error.message);
    if (withAnalysis) {
      const cached = await engine.files.write(
        assetId,
        ANALYSIS_FILENAME,
        JSON.stringify(USABLE_ANALYSIS),
      );
      if (!cached.ok) throw new Error(cached.error.message);
    }
    return assetId;
  }

  it("reports progress and stops an in-flight pass", async () => {
    await makeVideo(true);

    const idle = parse(await invoke("backfill_asset_tags", { action: "status" }));
    expect(idle.status).toBe("idle");
    expect(idle.total).toBe(1);
    expect(idle.counts).toMatchObject({ tagged: 0, needs_analysis: 0 });

    const started = parse(await invoke("backfill_asset_tags", { action: "start" }));
    expect(started.status).toBe("running");
    // The default pass spends nothing: adopting cached analysis is free.
    expect(started.allow_analysis).toBe(false);

    const paused = parse(await invoke("backfill_asset_tags", { action: "pause" }));
    expect(paused.status).toBe("paused");
    expect(readBackfillState(engine).status).toBe("paused");

    const cancelled = parse(await invoke("backfill_asset_tags", {
      action: "start",
    }));
    expect(cancelled.status).toBe("running");
    expect(parse(await invoke("backfill_asset_tags", { action: "cancel" })).status)
      .toBe("cancelled");
  });

  it("re-tags one asset and reports its tag state", async () => {
    const assetId = await makeVideo(true);

    const first = parse(await invoke("retag_asset", { asset_id: assetId }));
    expect(first.outcome).toBe("tagged");
    const tags = first.tags as { effective: Array<{ key: string }> };
    expect(tags.effective.map((tag) => tag.key)).toContain("kitchen");

    // Running again is a no-op until something changes.
    expect(parse(await invoke("retag_asset", { asset_id: assetId })).outcome)
      .toBe("already_current");
    expect(parse(await invoke("retag_asset", {
      asset_id: assetId,
      force: true,
    })).outcome).toBe("tagged");

    const missing = await invoke("retag_asset", {
      asset_id: "01a00000-0000-7000-8000-000000000000",
    });
    expect(missing.isError).toBe(true);
  });

  it("says an asset needs analysis instead of spending on a cached-only retry", async () => {
    const assetId = await makeVideo(false);
    const result = parse(await invoke("retag_asset", {
      asset_id: assetId,
      cached_only: true,
    }));
    expect(result.outcome).toBe("no_evidence");
    expect(result.tag_count).toBe(0);
  });

  it("configures automatic tagging without disabling manual tags", async () => {
    const initial = parse(await invoke("configure_asset_tagging"));
    expect(initial).toMatchObject({
      automatic_enabled: true,
      analysis_on_new_assets: true,
    });

    const disabled = parse(await invoke("configure_asset_tagging", {
      automatic_enabled: false,
    }));
    expect(disabled.automatic_enabled).toBe(false);
    expect(readTaggingSettings(engine).automaticEnabled).toBe(false);

    // With automatic tagging off, a new asset queues nothing at all.
    const assetId = await makeVideo(true);
    await enqueueAssetTagging(engine, assetId);
    expect(engine.jobs.queue.list({ type: "tag_asset" })).toEqual([]);

    // An explicit retag still runs: the setting governs automatic work only.
    await enqueueAssetTagging(engine, assetId, { force: true });
    expect(engine.jobs.queue.list({ type: "tag_asset" }).length).toBe(1);

    // Manual tagging is untouched by the setting.
    const manual = await engine.tags.add(assetId, {
      facet: "custom",
      label: "Keeper",
    });
    expect(manual.ok).toBe(true);
    expect(manual.ok && manual.value.effective.map((tag) => tag.key))
      .toEqual(["keeper"]);

    const reenabled = parse(await invoke("configure_asset_tagging", {
      automatic_enabled: true,
      analysis_on_new_assets: false,
    }));
    expect(reenabled).toMatchObject({
      automatic_enabled: true,
      analysis_on_new_assets: false,
    });
  });

  it("starts a fresh pass after a cancelled one rather than resuming it", async () => {
    await makeVideo(true);
    await invoke("backfill_asset_tags", { action: "start" });
    const state = readBackfillState(engine);
    writeBackfillState(engine, { ...state, cursor: "01a0", scanned: 5 });
    await invoke("backfill_asset_tags", { action: "cancel" });

    const restarted = parse(await invoke("backfill_asset_tags", { action: "start" }));
    expect(restarted.scanned).toBe(0);
    expect(readBackfillState(engine).cursor).toBeNull();
  });
});
