import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { Server, RequestListener } from "node:http";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEngine } from "videobook-engine";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { createDropbox } from "@apicity/dropbox";
import { createX } from "@apicity/x";
import { createPost, freezePostOutbound, getPost, linkPost, listPosts, migrateLegacyPosts, patchPostRuntime, readPostRuntime, updatePost } from "../posts/post-store.js";
import { dropboxContentHash, uploadPostToDropbox } from "../posts/dropbox-upload.js";
import { nextPostMetricAt, recordPostMetrics, refreshPostMetrics } from "../posts/post-metrics.js";
import { postRecordDefs } from "./post-record.js";
import { z } from "zod";
import { postToX, prepareXPublication } from "../x/post-to-x.js";

function value<T>(result: { ok: true; value: T } | { ok: false; error: { message: string } }): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value;
}

describe("Post publication records", () => {
  let root: string;
  let engine: Engine;
  let notebook: NotebookDocument;
  let source: NotebookCell;
  const servers: Server[] = [];

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "post-record-"));
    engine = createEngine({ rootDir: root, initialBookName: "post-tests", durableWrites: false });
    await engine.ready;
    notebook = value(await engine.notebooks.create("Clips"));
    const artifact = value(await engine.artifacts.create("video", "The clip"));
    value(await engine.files.write(artifact.artifactId, "original.mp4", Buffer.from("original clip")));
    const idea = engine.notebooks.createCell({ type: "prompt", prompt: "A dog learns to skate", slot: { row: 3, column: 0 } });
    source = engine.notebooks.createCell({ type: "video", slot: { row: 3, column: 1 }, outputArtifactId: artifact.artifactId, label: "Skating dog" });
    notebook = { ...notebook, cells: [idea, source], edges: [engine.notebooks.createEdge({ source: idea.id, target: source.id, targetInput: "media" })] };
    value(await engine.notebooks.write(notebook));
  });

  afterEach(async () => {
    for (const server of servers.splice(0)) await new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); });
    engine.close();
    await rm(root, { recursive: true, force: true });
  });

  async function serve(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("No address");
    return `http://127.0.0.1:${address.port}`;
  }

  it("freezes media and idea lineage, follows source moves and isolates a repost", async () => {
    const post = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id, platform: "tiktok", caption: "First take", credits: "Creator credit" });
    expect(post.address).toBe("@d3");
    expect(post.definition.lineage.map(item => item.prompt).filter(Boolean)).toEqual(["A dog learns to skate"]);
    value(await engine.files.write(source.outputArtifactId!, "original.mp4", Buffer.from("edited later")));
    const outbound = await freezePostOutbound(engine, post.id);
    expect(value(await engine.files.read(outbound.artifactId, outbound.filename)).toString()).toBe("original clip");
    expect(value(await engine.files.read(outbound.artifactId, "caption.txt")).toString()).toBe("First take\n\nCreator credit");
    await expect(updatePost(engine, post.id, { caption: "Changed" })).rejects.toThrow("frozen");
    const document = value(engine.notebooks.read(notebook.id));
    value(await engine.notebooks.write({ ...document, cells: document.cells.map(cell => cell.id === source.id ? { ...cell, slot: { row: 5, column: 4 } } : cell) }));
    expect(getPost(engine, post.id).definition.source?.cellId).toBe(source.id);
    const second = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id, platform: "tiktok" });
    expect(second.id).not.toBe(post.id);
    const date = new Date(Date.now() - 60_000).toISOString();
    await linkPost(engine, post.id, "https://www.tiktok.com/@creator/video/123?utm_source=share", date);
    await expect(linkPost(engine, second.id, "https://tiktok.com/@creator/video/123", date)).rejects.toThrow("already tracked");
    expect((await linkPost(engine, second.id, "https://tiktok.com/@creator/video/124", date)).runtime.url).toContain("124");
  });

  it("keeps receipts through undo/reopen and converts legacy cells in place", async () => {
    const legacy = engine.notebooks.createCell({ type: "video", slot: { row: 3, column: 2 }, outputArtifactId: source.outputArtifactId, inputs: { sourceOperation: "post_to_x", sourceCellId: source.id, tweetId: "123", tweetUrl: "https://x.com/i/web/status/123", postedAt: "2026-01-01T12:00:00Z", status: "partially_posted", replies: [{ tweetId: "124", tweetUrl: "https://x.com/i/web/status/124" }], followupError: { replyNumber: 2, message: "Reply failed" } } });
    const edge = engine.notebooks.createEdge({ source: source.id, target: legacy.id, targetInput: "post" });
    const downstream = engine.notebooks.createCell({ type: "video", slot: { row: 3, column: 3 }, outputArtifactId: source.outputArtifactId });
    const outgoing = engine.notebooks.createEdge({ source: legacy.id, target: downstream.id, targetInput: "media" });
    value(await engine.notebooks.write({ ...notebook, cells: [...notebook.cells, legacy, downstream], edges: [...notebook.edges, edge, outgoing] }));
    const legacyHead = engine.head;
    await migrateLegacyPosts(engine);
    const migrated = getPost(engine, legacy.id);
    expect(migrated.definition.source?.objectHash).toBeNull();
    expect(value(engine.notebooks.read(notebook.id)).edges).toContainEqual(edge);
    expect(value(engine.notebooks.read(notebook.id)).edges).toContainEqual({ ...outgoing, source: source.id });
    expect(migrated.runtime.url).toContain("123");
    expect(migrated.runtime.x).toMatchObject({ replies: [{ tweet_id: "124", tweet_url: "https://x.com/i/web/status/124" }], followupError: { reply_number: 2, message: "Reply failed" } });
    value(await engine.history.restore(legacyHead));
    expect(readPostRuntime(engine, legacy.id).url).toContain("123");
    await migrateLegacyPosts(engine);
    engine.close();
    engine = createEngine({ rootDir: root, durableWrites: false });
    await engine.ready;
    expect(getPost(engine, legacy.id).runtime.url).toContain("123");
    expect(listPosts(engine)).toHaveLength(1);
  });

  it("captures implicit producer and goal ancestry without graph edges", async () => {
    const goal = engine.notebooks.createCell({ type: "goal", slot: { row: 0, column: 0 }, prompt: "Teach courage through a skating dog", inputs: { goalId: notebook.id } });
    const idea = { ...notebook.cells[0]!, inputs: { goalId: notebook.id } };
    source = { ...source, inputs: { producerCellId: idea.id } };
    value(await engine.notebooks.write({ ...notebook, cells: [goal, idea, source], edges: [] }));
    const post = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id });
    expect(post.definition.lineage.map(cell => cell.prompt).filter(Boolean)).toEqual(["Teach courage through a skating dog", "A dog learns to skate"]);
  });

  it("keeps the delivered platform and caption when undo restores an earlier draft", async () => {
    const draft = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id, caption: "Earlier X draft" });
    const checkpoint = engine.head;
    await updatePost(engine, draft.id, { platform: "instagram", caption: "Final Instagram caption", credits: "Studio", account: "@studio" });
    await linkPost(engine, draft.id, "https://instagram.com/reel/finished", new Date().toISOString());
    value(await engine.history.restore(checkpoint));
    expect(getPost(engine, draft.id).definition).toMatchObject({ platform: "instagram", caption: "Final Instagram caption", credits: "Studio", account: "@studio" });
    await updatePost(engine, draft.id, { notes: "Keep this idea" });
    expect(getPost(engine, draft.id).definition).toMatchObject({ platform: "instagram", caption: "Final Instagram caption", notes: "Keep this idea" });
    await expect(updatePost(engine, draft.id, { caption: "New caption" })).rejects.toThrow("frozen");
  });

  it("retains missing metrics, manual history and real observation ages", async () => {
    const post = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id, platform: "instagram" });
    const postedAt = new Date(Date.now() - 2 * 3_600_000).toISOString();
    await linkPost(engine, post.id, "https://instagram.com/reel/abc", postedAt);
    const linked = getPost(engine, post.id);
    expect(linked.runtime.outbound?.objectHash).toBe(post.definition.source?.objectHash);
    patchPostRuntime(engine, post.id, { status: "partially_posted", error: "A reply failed" });
    expect((await linkPost(engine, post.id, "https://instagram.com/reel/abc", new Date().toISOString())).runtime).toMatchObject({ status: "partially_posted", postedAt, error: "A reply failed" });
    recordPostMetrics(engine, post.id, { source: "manual", observedAt: new Date().toISOString(), values: { views: 0, likes: 15, impressions: null } });
    expect(getPost(engine, post.id).runtime.metrics[0]?.values).toEqual({ views: 0, likes: 15, impressions: null });
    expect(nextPostMetricAt(postedAt, new Date().toISOString())).toBe(new Date(new Date(postedAt).getTime() + 24 * 3_600_000).toISOString());
    const schema = z.object(postRecordDefs(engine).find(def => def.name === "record_post_metrics")!.schema);
    expect(schema.safeParse({ book_id: "book", post_cell_id: post.id, observed_at: new Date().toISOString(), values: { likes: 0 } }).success).toBe(true);
    expect(schema.safeParse({ book_id: "book", post_cell_id: post.id, observed_at: new Date().toISOString(), values: { likes: -1 } }).success).toBe(false);
  });

  it("resumes lost chunk acknowledgments and caption failures across restart without duplicate delivery", async () => {
    const video = Buffer.alloc(8 * 1024 * 1024 + 100, "v");
    value(await engine.files.write(source.outputArtifactId!, "original.mp4", video));
    const files = new Map<string, { bytes: Buffer; rev: string }>();
    const sessions = new Map<string, Buffer>();
    let videoFinishes = 0;
    let failCaption = true;
    let failAppend = true;
    const base = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const args = JSON.parse(String(req.headers["dropbox-api-arg"] ?? "{}")) as { cursor?: { session_id: string; offset: number }; commit?: { path: string } };
      res.setHeader("Content-Type", "application/json");
      const metadata = (path: string, file: { bytes: Buffer; rev: string }) => ({ ".tag": "file", id: `id:${path}`, rev: file.rev, name: path.split("/").at(-1), size: file.bytes.length, content_hash: dropboxContentHash(file.bytes), client_modified: new Date().toISOString(), server_modified: new Date().toISOString() });
      if (req.url === "/files/get_metadata") {
        const path = (JSON.parse(body.toString()) as { path: string }).path;
        const file = files.get(path);
        res.writeHead(file ? 200 : 409).end(JSON.stringify(file ? metadata(path, file) : { error_summary: "path/not_found/", error: { ".tag": "path", path: { ".tag": "not_found" } } }));
      } else if (req.url === "/files/upload_session/start") {
        const id = `session-${sessions.size}`;
        sessions.set(id, body);
        res.end(JSON.stringify({ session_id: id }));
      } else if (req.url === "/files/upload_session/append_v2") {
        const previous = sessions.get(args.cursor!.session_id)!;
        if (args.cursor!.offset !== previous.length) { res.writeHead(409).end(JSON.stringify({ error_summary: "incorrect_offset/", error: { ".tag": "incorrect_offset", correct_offset: previous.length } })); return; }
        sessions.set(args.cursor!.session_id, Buffer.concat([previous, body]));
        if (failAppend) { failAppend = false; res.writeHead(503).end(JSON.stringify({ error_summary: "acknowledgment_lost" })); return; }
        res.end("null");
      } else if (req.url === "/files/upload_session/finish") {
        const path = args.commit!.path;
        if (path.endsWith("caption.txt") && failCaption) { failCaption = false; res.writeHead(503).end(JSON.stringify({ error_summary: "temporarily_unavailable" })); return; }
        if (path.endsWith(".mp4")) videoFinishes += 1;
        const file = { bytes: sessions.get(args.cursor!.session_id)!, rev: "rev1" };
        files.set(path, file);
        res.end(JSON.stringify(metadata(path, file)));
      } else res.writeHead(404).end("{}");
    });
    const client = createDropbox({ oauthToken: "local-test-token", apiBaseURL: base, contentBaseURL: base });
    const post = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id, caption: "Caption", credits: "Credit" });
    await expect(uploadPostToDropbox(engine, post.id, { client })).rejects.toThrow("503");
    expect(readPostRuntime(engine, post.id).dropbox?.video.offset).toBe(0);
    await expect(uploadPostToDropbox(engine, post.id, { client })).rejects.toThrow("503");
    expect(readPostRuntime(engine, post.id).dropbox?.video.rev).toBe("rev1");
    engine.close();
    engine = createEngine({ rootDir: root, durableWrites: false });
    await engine.ready;
    await uploadPostToDropbox(engine, post.id, { client });
    expect(videoFinishes).toBe(1);
    expect(getPost(engine, post.id).runtime.status).toBe("ready");
    expect([...files.values()][0]!.bytes.equals(video)).toBe(true);
    expect([...files.values()][1]!.bytes.toString()).toBe("Caption\n\nCredit");
  });

  it("saves an edited caption before the first Dropbox delivery and refuses to change it afterwards", async () => {
    const files = new Map<string, Buffer>();
    const sessions = new Map<string, Buffer>();
    const base = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks);
      const args = JSON.parse(String(req.headers["dropbox-api-arg"] ?? "{}")) as { cursor?: { session_id: string }; commit?: { path: string } };
      res.setHeader("Content-Type", "application/json");
      const metadata = (path: string, bytes: Buffer) => ({ ".tag": "file", id: `id:${path}`, rev: "rev1", name: path.split("/").at(-1), size: bytes.length, content_hash: dropboxContentHash(bytes), client_modified: new Date().toISOString(), server_modified: new Date().toISOString() });
      if (req.url === "/files/get_metadata") {
        const path = (JSON.parse(body.toString()) as { path: string }).path;
        const file = files.get(path);
        res.writeHead(file ? 200 : 409).end(JSON.stringify(file ? metadata(path, file) : { error_summary: "path/not_found/", error: { ".tag": "path", path: { ".tag": "not_found" } } }));
      } else if (req.url === "/files/upload_session/start") {
        const id = `session-${sessions.size}`;
        sessions.set(id, body);
        res.end(JSON.stringify({ session_id: id }));
      } else if (req.url === "/files/upload_session/append_v2") {
        sessions.set(args.cursor!.session_id, Buffer.concat([sessions.get(args.cursor!.session_id)!, body]));
        res.end("null");
      } else if (req.url === "/files/upload_session/finish") {
        const bytes = sessions.get(args.cursor!.session_id)!;
        files.set(args.commit!.path, bytes);
        res.end(JSON.stringify(metadata(args.commit!.path, bytes)));
      } else res.writeHead(404).end("{}");
    });
    const client = createDropbox({ oauthToken: "local-test-token", apiBaseURL: base, contentBaseURL: base });
    const post = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id, caption: "Draft caption" });
    await uploadPostToDropbox(engine, post.id, { client, folder: "/Deliveries/skate", caption: "Edited in review" });
    expect(getPost(engine, post.id).definition.caption).toBe("Edited in review");
    expect(files.get("/Deliveries/skate/caption.txt")?.toString()).toBe("Edited in review");
    await expect(uploadPostToDropbox(engine, post.id, { client, folder: "/Deliveries/skate", caption: "Another caption" })).rejects.toThrow("frozen at its first delivery");
    await uploadPostToDropbox(engine, post.id, { client, folder: "/Deliveries/skate", caption: "Edited in review" });
    expect(getPost(engine, post.id).runtime.dropbox?.completedAt).toBeTruthy();
  });

  it("collects available X metrics and labels shared media views", async () => {
    let requests = 0;
    const base = await serve((req, res) => {
      requests += 1;
      res.setHeader("Content-Type", "application/json");
      if (req.url?.includes("non_public_metrics")) { res.writeHead(403).end(JSON.stringify({ title: "Not authorized", detail: "Public metrics only" })); return; }
      res.end(JSON.stringify({ data: { id: "123", text: "Clip", public_metrics: { like_count: 0, impression_count: 200 } }, includes: { media: [{ media_key: "7_123", type: "video", public_metrics: { view_count: 500 } }] } }));
    });
    const x = createX({ accessToken: "local-test-token", baseURL: base });
    const post = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id });
    await linkPost(engine, post.id, "https://twitter.com/creator/status/123?s=20", new Date(Date.now() - 7200_000).toISOString());
    const result = await refreshPostMetrics(engine, post.id, { x });
    expect(requests).toBe(2);
    expect(result.values).toEqual({ likes: 0, impressions: 200 });
    expect(result.mediaViews).toBe(500);
    expect(result.values.views).toBeUndefined();
    expect(result.note).toContain("other posts");
  });

  it("never republishes an uncertain X request and retains the frozen scheduled media", async () => {
    let publications = 0;
    const chunks: string[] = [];
    const base = await serve(async (req, res) => {
      const body: Buffer[] = [];
      for await (const chunk of req) body.push(Buffer.from(chunk));
      const text = Buffer.concat(body).toString();
      res.setHeader("Content-Type", "application/json");
      if (req.url?.endsWith("/initialize")) res.end(JSON.stringify({ data: { id: "100", expires_after_secs: 86400 } }));
      else if (req.url?.endsWith("/append")) { chunks.push(text); res.end(JSON.stringify({ data: {} })); }
      else if (req.url?.endsWith("/finalize")) res.end(JSON.stringify({ data: { id: "100", processing_info: { state: "succeeded" } } }));
      else if (req.url === "/2/tweets") { publications += 1; res.writeHead(500).end(JSON.stringify({ title: "Unknown outcome", detail: "Connection interrupted after accepting request" })); }
      else res.writeHead(404).end("{}");
    });
    const x = createX({ accessToken: "local-test-token", baseURL: base });
    const attachment = value(await engine.artifacts.create("image", "Reply image"));
    value(await engine.files.write(attachment.artifactId, "original.png", Buffer.from("frozen reply image")));
    const draft = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id, caption: "Scheduled caption" });
    const checkpoint = engine.head;
    const args = { engine, assetId: source.outputArtifactId!, postCellId: draft.id, bookId: engine.book.get().bookId, text: "Scheduled caption", followups: [{ text: "Behind the scenes", image_asset_ids: [attachment.artifactId] }], x };
    const post = await prepareXPublication(args);
    value(await engine.history.restore(checkpoint));
    value(await engine.files.write(source.outputArtifactId!, "original.mp4", Buffer.from("later clip")));
    value(await engine.files.write(attachment.artifactId, "original.png", Buffer.from("later reply image")));
    await expect(postToX({ ...args, postCellId: post.id })).rejects.toThrow("Connection interrupted");
    expect(chunks.join(" ")).toContain("original clip");
    expect(chunks.join(" ")).not.toContain("later clip");
    expect(chunks.join(" ")).toContain("frozen reply image");
    expect(chunks.join(" ")).not.toContain("later reply image");
    expect(getPost(engine, post.id).runtime.status).toBe("needs_reconciliation");
    await expect(postToX({ ...args, postCellId: post.id })).rejects.toThrow("uncertain");
    await expect(postToX({ ...args, followups: [{ text: "Changed reply" }] })).rejects.toThrow("frozen X request");
    expect(publications).toBe(1);
    await linkPost(engine, post.id, "https://x.com/creator/status/123", new Date().toISOString());
    await expect(postToX({ ...args, postCellId: post.id })).rejects.toThrow("already");
    expect(publications).toBe(1);
  });

  it("pauses authorization failures and backs off rate limits without fabricating observations", async () => {
    let status = 429;
    const base = await serve((_req, res) => { res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify({ title: "Unavailable" })); });
    const x = createX({ accessToken: "local-test-token", baseURL: base });
    const post = await createPost(engine, { notebookId: notebook.id, sourceCellId: source.id });
    await linkPost(engine, post.id, "https://x.com/creator/status/456", new Date(Date.now() - 86_400_000).toISOString());
    await expect(refreshPostMetrics(engine, post.id, { x })).rejects.toThrow();
    expect(new Date(getPost(engine, post.id).runtime.nextMetricAt!).getTime()).toBeGreaterThan(Date.now() + 14 * 60_000);
    status = 401;
    await expect(refreshPostMetrics(engine, post.id, { x })).rejects.toThrow();
    expect(getPost(engine, post.id).runtime).toMatchObject({ metrics: [], metricsPaused: true, nextMetricAt: null });
  });

  it("reuses a legacy scheduled job's publication after restart", async () => {
    const args = { assetId: source.outputArtifactId!, bookId: engine.book.get().bookId, text: "Scheduled caption", publicationKey: "schedule:legacy-post" };
    const prepared = await prepareXPublication({ ...args, engine });
    patchPostRuntime(engine, prepared.id, { status: "needs_reconciliation" });
    engine.close();
    engine = createEngine({ rootDir: root, durableWrites: false });
    await engine.ready;
    expect((await prepareXPublication({ ...args, engine })).id).toBe(prepared.id);
    await expect(postToX({ ...args, engine })).rejects.toThrow("uncertain");
    expect(listPosts(engine)).toHaveLength(1);
  });
});
