import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  schedulePost,
  cancelScheduledPost,
  listScheduledPosts,
  loadAndArmAll,
  stopScheduler,
} from "./scheduled-posts.js";

describe("scheduled-posts persistence", () => {
  let tempDir: string;
  let stateFile: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videocity-sched-"));
    stateFile = join(tempDir, "scheduled-posts.json");
    process.env.SCHEDULED_POSTS_PATH = stateFile;
  });

  afterEach(async () => {
    stopScheduler();
    delete process.env.SCHEDULED_POSTS_PATH;
    await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("persists a scheduled post to disk and lists it", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const result = await schedulePost(
      {
        asset_id: "vid-test",
        project_slug: "p1",
        platform: "x",
        text: "hello",
      },
      future,
    );

    expect(result.schedule_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.scheduled_for).toBe(new Date(future).toISOString());

    const fileContent = JSON.parse(await readFile(stateFile, "utf8")) as Array<{
      schedule_id: string;
      status: string;
      payload: { asset_id: string };
    }>;
    expect(fileContent).toHaveLength(1);
    expect(fileContent[0].schedule_id).toBe(result.schedule_id);
    expect(fileContent[0].status).toBe("pending");
    expect(fileContent[0].payload.asset_id).toBe("vid-test");

    const listed = await listScheduledPosts();
    expect(listed).toHaveLength(1);
    expect(listed[0].schedule_id).toBe(result.schedule_id);
  });

  it("cancels a pending scheduled post", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    const { schedule_id } = await schedulePost(
      { asset_id: "img-test", project_slug: "p1", platform: "x" },
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
        { asset_id: "vid-x", project_slug: "p1", platform: "x" },
        "not-a-date",
      ),
    ).rejects.toThrow(/Invalid scheduled_for/);
  });

  it("loadAndArmAll runs without throwing on empty state", async () => {
    await expect(loadAndArmAll()).resolves.toBeUndefined();
  });

  it("loadAndArmAll re-arms pending entries from disk", async () => {
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    await schedulePost(
      { asset_id: "vid-survive", project_slug: "p1", platform: "x" },
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
