import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Engine } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "./engine.js";
import { queue, setEngineRoot } from "./queue.js";
import {
  schedulePost,
  cancelScheduledPost,
  listScheduledPosts,
  loadAndArmAll,
  SCHEDULED_POST_SETTINGS_KEY,
  stopScheduler,
} from "./scheduled-posts.js";

describe("scheduled-posts persistence", () => {
  let tempDir: string;
  let engine: Engine;
  let bookId: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-sched-"));
    engine = createEngineForTest(tempDir);
    await setEngineRoot(tempDir, engine);
    bookId = engine.book.get().bookId;
  });

  afterEach(async () => {
    stopScheduler();
    await queue.stop();
    closeEngineForTest(tempDir, engine);
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("persists a scheduled post in per-book runtime settings and lists it", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = await schedulePost(
      {
        asset_id: "vid-test",
        book_id: bookId,
        platform: "x",
        text: "hello",
      },
      future,
    );

    expect(result.schedule_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.scheduled_for).toBe(new Date(future).toISOString());

    await expect(stat(join(tempDir, "data", "videobook.db"))).resolves.toBeDefined();

    const listed = await listScheduledPosts();
    expect(listed).toHaveLength(1);
    expect(listed[0].schedule_id).toBe(result.schedule_id);
    expect(listed[0].status).toBe("pending");
    expect(listed[0].payload.asset_id).toBe("vid-test");
    expect(engine.settings.get(SCHEDULED_POST_SETTINGS_KEY)).toEqual(listed);
  });

  it("cancels a pending scheduled post", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const { schedule_id } = await schedulePost(
      { asset_id: "img-test", book_id: bookId, platform: "x" },
      future,
    );

    const cancelled = await cancelScheduledPost(schedule_id);
    expect(cancelled).toBe(true);

    const listed = await listScheduledPosts();
    expect(listed[0].status).toBe("cancelled");
  });

  it("rejects invalid scheduled_for", async () => {
    await expect(
      schedulePost(
        { asset_id: "vid-x", book_id: bookId, platform: "x" },
        "not-a-date",
      ),
    ).rejects.toThrow(/Invalid scheduled_for/);
  });

  it("loadAndArmAll runs without throwing on empty state", async () => {
    await expect(loadAndArmAll()).resolves.toBeUndefined();
  });

  it("loadAndArmAll re-arms pending entries from Dolt", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await schedulePost(
      { asset_id: "vid-survive", book_id: bookId, platform: "x" },
      future,
    );
    stopScheduler(); // simulate restart by clearing in-memory timers

    await loadAndArmAll();
    const listed = await listScheduledPosts();
    expect(listed).toHaveLength(1);
    expect(listed[0].status).toBe("pending");
  });

  it("returns false when cancelling an unknown schedule id", async () => {
    const cancelled = await cancelScheduledPost("non-existent-id");
    expect(cancelled).toBe(false);
  });
});
