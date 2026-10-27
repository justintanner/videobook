import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { closeEngineForTest, createEngineForTest } from "../engine.js";
import { registerPostRecordJobs } from "../jobs/post-record.js";
import type { PostView } from "../posts/post-contract.js";
import type { PostDownload } from "../posts/post-folder.js";
import { queue, setEngineRoot } from "../queue.js";
import { SCHEDULED_POST_SETTINGS_KEY, schedulePost, stopScheduler } from "../scheduled-posts.js";
import { serviceStatusDef } from "./connect-service.js";
import { postDef } from "./post.js";
import { postRecordDefs } from "./post-record.js";
import type { ToolDef } from "./tool-def.js";

type DeliveredPost = { post: PostView; download?: PostDownload; message: string };

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

async function invoke<T>(def: ToolDef, args: Record<string, unknown>): Promise<T> {
  const result = await def.handler(args);
  const text = result.content[0]?.text ?? "";
  if (result.isError) throw new Error(text);
  return JSON.parse(text) as T;
}

describe("one-step posting tools", () => {
  let root: string;
  let icloud: string;
  let previousIcloud: string | undefined;
  let engine: Engine;
  let bookId: string;
  let notebook: NotebookDocument;
  let source: NotebookCell;
  let records: ToolDef[];
  const post = postDef();
  const record = (name: string): ToolDef => {
    const def = records.find((item) => item.name === name);
    if (!def) throw new Error(`${name} is not registered`);
    return def;
  };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "post-flow-"));
    icloud = await mkdtemp(join(tmpdir(), "post-flow-icloud-"));
    previousIcloud = process.env.VIDEOBOOK_ICLOUD_DIR;
    process.env.VIDEOBOOK_ICLOUD_DIR = join(icloud, "Videobook");
    engine = createEngineForTest(root);
    await setEngineRoot(root, engine);
    bookId = engine.book.get().bookId;
    registerPostRecordJobs(engine);
    notebook = value(await engine.notebooks.create("Clips"));
    const artifact = value(await engine.artifacts.create("video", "Skating dog"));
    value(await engine.files.write(artifact.artifactId, "original.mp4", Buffer.from("original clip")));
    source = engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: artifact.artifactId, label: "Skating dog" });
    notebook = { ...notebook, cells: [source] };
    value(await engine.notebooks.write(notebook));
    records = postRecordDefs(engine);
  });

  afterEach(async () => {
    stopScheduler();
    await queue.stop();
    closeEngineForTest(root, engine);
    if (previousIcloud === undefined) delete process.env.VIDEOBOOK_ICLOUD_DIR;
    else process.env.VIDEOBOOK_ICLOUD_DIR = previousIcloud;
    await rm(root, { recursive: true, force: true, maxRetries: 3 });
    await rm(icloud, { recursive: true, force: true });
  });

  it("downloads a clip for a manual upload in one step and keeps the frozen files", async () => {
    const delivered = await invoke<DeliveredPost>(post, { book_id: bookId, to: "download", asset_id: source.outputArtifactId, text: "Rain or shine", platform: "instagram" });
    expect(delivered.post.address).toBe("@a2");
    expect(delivered.post.definition).toMatchObject({ platform: "instagram", caption: "Rain or shine", source: { cellId: source.id } });
    expect(delivered.post.runtime.status).toBe("ready");
    expect(delivered.post.runtime.download?.completedAt).toEqual(expect.any(String));
    const outbound = delivered.post.runtime.outbound!;
    const name = `${engine.book.get().name}-post-a2-${delivered.post.id.slice(-6)}`;
    expect(delivered.download).toEqual({
      clip_url: `/files/${bookId}/${outbound.artifactId}/original.mp4?download=${encodeURIComponent(`${name}.mp4`)}`,
      caption_url: `/files/${bookId}/${outbound.artifactId}/caption.txt?download=${encodeURIComponent(`${name}.txt`)}`,
      filename: `${name}.mp4`,
      caption: "Rain or shine",
    });
    expect(delivered.message).toBe(`@a2 is ready to download as ${name}.mp4 with its caption`);
    expect(value(await engine.files.read(outbound.artifactId, "original.mp4")).toString()).toBe("original clip");
    expect(value(await engine.files.read(outbound.artifactId, "caption.txt")).toString()).toBe("Rain or shine");

    const repeated = await invoke<DeliveredPost>(post, { book_id: bookId, to: "download", post_cell_id: delivered.post.id, text: "Rain or shine" });
    expect(repeated.download).toEqual(delivered.download);
    await expect(invoke(post, { book_id: bookId, to: "download", post_cell_id: delivered.post.id, text: "Another caption" })).rejects.toThrow("frozen at its first delivery");
  });

  it("saves a clip to iCloud in one step and reports that Post's upload through service_status", async () => {
    const saved = await invoke<DeliveredPost>(post, { book_id: bookId, to: "icloud", asset_id: source.outputArtifactId, text: "Caption", folder: "skate" });
    expect(saved.message).toBe(`Saved ${saved.post.address} to iCloud · Videobook/skate`);
    expect(saved.post.runtime.icloud?.completedAt).toEqual(expect.any(String));
    expect(await readFile(join(icloud, "Videobook", "skate", "clip.mp4"), "utf8")).toBe("original clip");
    expect(await readFile(join(icloud, "Videobook", "skate", "caption.txt"), "utf8")).toBe("Caption");
    expect(await invoke(serviceStatusDef(), { service: "icloud", book_id: bookId, post_cell_id: saved.post.id })).toEqual({ phase: "not-icloud", error: null });
    await expect(invoke(serviceStatusDef(), { service: "icloud", post_cell_id: saved.post.id })).rejects.toThrow("book_id is required with post_cell_id");
  });

  it("drafts a Post without a clip, then links and records it by hand", async () => {
    const drafted = await invoke<DeliveredPost>(post, { book_id: bookId, to: "draft", notebook_id: notebook.id });
    expect(drafted.post.definition).toMatchObject({ platform: "tiktok", source: null });
    await expect(invoke(post, { book_id: bookId, to: "download", post_cell_id: drafted.post.id })).rejects.toThrow("has no saved source clip");
    const postedAt = new Date(Date.now() - 60_000).toISOString();
    await expect(invoke(record("update_post"), { book_id: bookId, post_cell_id: drafted.post.id, url: "https://www.tiktok.com/@me/video/1" })).rejects.toThrow("posted_at is required with url");

    const linked = await invoke<PostView>(record("update_post"), { book_id: bookId, post_cell_id: drafted.post.id, source_cell_id: source.id, caption: "Skate day", url: "https://www.tiktok.com/@me/video/1?is_from_webapp=1", posted_at: postedAt });
    expect(linked.definition).toMatchObject({ caption: "Skate day", source: { cellId: source.id } });
    expect(linked.runtime).toMatchObject({ status: "posted", url: "https://tiktok.com/@me/video/1", postedAt });

    const observed = await invoke<PostView>(record("record_post_metrics"), { book_id: bookId, post_cell_id: drafted.post.id, values: { views: 1200, likes: 0 } });
    expect(observed.runtime.metrics.at(-1)).toMatchObject({ source: "manual", values: { views: 1200, likes: 0 } });
    await expect(invoke(record("record_post_metrics"), { book_id: bookId, post_cell_id: drafted.post.id })).rejects.toThrow("Automatic metrics need a linked X publication");

    const listed = await invoke<{ posts: PostView[] }>(record("list_posts"), { book_id: bookId });
    expect(listed.posts.map((item) => item.id)).toEqual([drafted.post.id]);
    expect((await invoke<{ posts: PostView[] }>(record("list_posts"), { book_id: bookId, post_cell_id: drafted.post.id })).posts[0]?.runtime.metrics).toHaveLength(1);
    expect((await invoke<{ posts: PostView[] }>(record("list_posts"), { book_id: bookId, status: "draft" })).posts).toEqual([]);
  });

  it("lists scheduled X posts and cancels one back to a draft", async () => {
    const drafted = await invoke<DeliveredPost>(post, { book_id: bookId, to: "draft", asset_id: source.outputArtifactId, platform: "x", text: "Launch day" });
    const scheduled = await schedulePost({ asset_id: source.outputArtifactId!, book_id: bookId, platform: "x", text: "Launch day", post_cell_id: drafted.post.id }, new Date(Date.now() + 3_600_000).toISOString());

    const pending = await invoke<{ posts: PostView[] }>(record("list_posts"), { book_id: bookId, status: "scheduled" });
    expect(pending.posts.map((item) => [item.id, item.runtime.scheduledFor, item.runtime.scheduleId])).toEqual([[drafted.post.id, scheduled.scheduled_for, scheduled.schedule_id]]);

    const cancelled = await invoke<PostView>(record("update_post"), { book_id: bookId, post_cell_id: drafted.post.id, cancel_schedule: true });
    expect(cancelled.runtime.status).toBe("draft");
    expect(cancelled.runtime.scheduleId).toBeUndefined();
    expect(cancelled.runtime.scheduledFor).toBeUndefined();
    expect((await invoke<{ posts: PostView[] }>(record("list_posts"), { book_id: bookId, status: "scheduled" })).posts).toEqual([]);
    expect(engine.settings.get(SCHEDULED_POST_SETTINGS_KEY)).toEqual([expect.objectContaining({ schedule_id: scheduled.schedule_id, status: "cancelled" })]);
    await expect(invoke(record("update_post"), { book_id: bookId, post_cell_id: drafted.post.id, cancel_schedule: true })).rejects.toThrow("no scheduled publication to cancel");
  });
});
