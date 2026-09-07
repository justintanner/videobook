import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import {
  readBackfillState,
  recordOutcome,
  writeBackfillState,
  EMPTY_COUNTS,
} from "../tag-backfill-state.js";
import { runAssetTagBackfill, startedState } from "./backfill-asset-tags.js";

const ANALYSIS_FILENAME = ".original.analysis.json";

const USABLE_ANALYSIS = {
  summary: "Someone cooks while talking to camera.",
  setting: "A domestic kitchen",
  subjects: ["one person"],
  tags: ["closeup", "beautiful"],
  actions: [],
  scenes: [],
};

describe("asset tag backfill", () => {
  let tempDir: string;
  let engine: Engine;
  let bookId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-backfill-"));
    engine = createEngineForTest(tempDir);
    await engine.ready;
    bookId = engine.book.get().bookId;
  });

  afterEach(async () => {
    closeEngineForTest(tempDir, engine);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

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

  function start(options: { allowAnalysis?: boolean; force?: boolean; resume?: boolean } = {}) {
    return writeBackfillState(engine, startedState(readBackfillState(engine), {
      allowAnalysis: options.allowAnalysis === true,
      force: options.force === true,
      resume: options.resume === true,
    }));
  }

  async function run() {
    return await runAssetTagBackfill(engine, {
      type: "backfill_asset_tags",
      bookId,
    });
  }

  function effective(assetId: string): string[] {
    const state = engine.tags.read(assetId);
    if (!state.ok) throw new Error(state.error.message);
    return state.value.effective.map((tag) => tag.key).sort();
  }

  it("adopts tags from analysis the book already paid for", async () => {
    const cached = await makeVideo(true);
    const uncached = await makeVideo(false);

    start();
    const state = await run();

    expect(state.status).toBe("completed");
    expect(state.scanned).toBe(2);
    expect(state.counts.tagged).toBe(1);
    // Nothing was requested from a provider: the pass reports the gap instead.
    expect(state.counts.needsAnalysis).toBe(1);
    expect(effective(cached)).toContain("kitchen");
    expect(effective(cached)).toContain("close-up");
    // Legacy noise never becomes a tag.
    expect(effective(cached).join(" ")).not.toContain("beautiful");
    expect(effective(uncached)).toEqual([]);
  });

  it("skips assets that are already current and re-tags them when forced", async () => {
    const assetId = await makeVideo(true);

    start();
    expect((await run()).counts.tagged).toBe(1);

    start();
    const second = await run();
    expect(second.counts.tagged).toBe(0);
    expect(second.counts.current).toBe(1);

    start({ force: true });
    const forced = await run();
    expect(forced.counts.tagged).toBe(1);
    // A forced pass re-fences rather than clearing what a user chose.
    expect(effective(assetId)).toContain("kitchen");
  });

  it("keeps manual tags and dismissals across a forced pass", async () => {
    const assetId = await makeVideo(true);
    const manual = await engine.tags.add(assetId, {
      facet: "custom",
      label: "Hero shot",
    });
    expect(manual.ok).toBe(true);

    start();
    await run();
    const dismissed = await engine.tags.remove(assetId, {
      facet: "places",
      label: "kitchen",
    });
    expect(dismissed.ok).toBe(true);

    start({ force: true });
    await run();
    expect(effective(assetId)).toContain("hero shot");
    expect(effective(assetId)).not.toContain("kitchen");
  });

  it("stops at a page boundary when paused and resumes where it stopped", async () => {
    // More than one page, so the pass has a boundary to stop at.
    const assets: string[] = [];
    for (let index = 0; index < 30; index += 1) {
      assets.push(await makeVideo(true));
    }

    start();
    // Pausing before the first page is written stops the pass immediately.
    const running = readBackfillState(engine);
    writeBackfillState(engine, { ...running, status: "paused" });
    const paused = await run();
    expect(paused.status).toBe("paused");
    expect(paused.scanned).toBe(0);

    start({ resume: true });
    const finished = await run();
    expect(finished.status).toBe("completed");
    expect(finished.scanned).toBe(30);
    expect(finished.counts.tagged).toBe(30);
  });

  it("resumes after the catalog changed behind the cursor", async () => {
    const first = await makeVideo(true);
    const second = await makeVideo(true);
    const third = await makeVideo(true);

    // A pass that stopped after the first asset.
    writeBackfillState(engine, {
      ...startedState(readBackfillState(engine), {
        allowAnalysis: false,
        force: false,
        resume: false,
      }),
      cursor: first,
      scanned: 1,
      counts: { ...EMPTY_COUNTS, tagged: 1 },
    });
    // Deleting an asset behind the cursor would shift every offset-based page.
    const deleted = await engine.artifacts.delete(first);
    expect(deleted.ok).toBe(true);

    const state = await run();
    expect(state.status).toBe("completed");
    expect(state.counts.tagged).toBe(3);
    expect(effective(second)).toContain("kitchen");
    expect(effective(third)).toContain("kitchen");
  });

  it("stops on cancel and does not resume from the cancelled cursor", async () => {
    await makeVideo(true);
    start();
    const running = readBackfillState(engine);
    writeBackfillState(engine, { ...running, status: "cancelled" });

    const state = await run();
    expect(state.status).toBe("cancelled");

    // Starting again is a fresh pass, not a continuation of a cancelled one.
    const restarted = start();
    expect(restarted.cursor).toBeNull();
    expect(restarted.scanned).toBe(0);
    expect((await run()).counts.tagged).toBe(1);
  });

  it("pauses rather than cancels when the process is shutting down", async () => {
    await makeVideo(true);
    start();
    const controller = new AbortController();
    controller.abort();

    const state = await runAssetTagBackfill(
      engine,
      { type: "backfill_asset_tags", bookId },
      { signal: controller.signal },
    );
    expect(state.status).toBe("paused");
    expect(state.scanned).toBe(0);
  });

  it("counts every outcome the coordinator can report", () => {
    const counted = [
      "tagged", "already_current", "no_useful_evidence", "no_evidence",
      "analysis_requested", "analysis_unavailable", "unsupported_kind",
      "missing_asset", "no_source_content", "failed",
    ].reduce(recordOutcome, EMPTY_COUNTS);
    expect(counted).toEqual({
      tagged: 1,
      current: 1,
      empty: 1,
      needsAnalysis: 3,
      unsupported: 1,
      skipped: 2,
      failed: 1,
    });
  });
});
