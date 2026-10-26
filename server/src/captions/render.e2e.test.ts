import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { queue, waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import type { CaptionDocument } from "./model.js";
import type { CaptionReadModel } from "./service.js";

const execFileAsync = promisify(execFile);
const WIDTH = 1080;
const HEIGHT = 1920;
const TRANSCRIPT = {
  language_code: "eng",
  words: [
    { text: "Hello", start: 0.2, end: 0.7, type: "word" },
    { text: "big", start: 0.8, end: 1.1, type: "word" },
    { text: "world.", start: 1.2, end: 1.8, type: "word" },
  ],
};
const HIGHLIGHT = [0xff, 0xe1, 0x4d] as const;

type TextContent = Array<{ type: string; text: string }>;
type Read = CaptionReadModel & { document: CaptionDocument; render: { status: string; job_id: number; output_asset_id: string; cell_id: string | null; address: string | null; error: string | null } | null };

interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  count: number;
}

describe("caption render", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let assetId: string;
  let notebookId: string;
  let sourceHash: string;
  const bookId = "caption-render-book";

  async function call<T>(args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name: "caption_video", arguments: { book_id: bookId, asset_id: assetId, ...args } });
    const text = (result.content as TextContent)[0].text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  }

  async function frame(path: string, seconds: number): Promise<Buffer> {
    const { stdout } = await execFileAsync(FFMPEG, [
      "-v", "error", "-ss", seconds.toFixed(3), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], { encoding: "buffer", maxBuffer: WIDTH * HEIGHT * 4 });
    return stdout;
  }

  function colorBox(pixels: Buffer, target: readonly [number, number, number], tolerance: number): Box {
    const box: Box = { minX: WIDTH, maxX: -1, minY: HEIGHT, maxY: -1, count: 0 };
    for (let y = 0; y < HEIGHT; y += 2) {
      for (let x = 0; x < WIDTH; x += 2) {
        const offset = (y * WIDTH + x) * 3;
        if (Math.abs(pixels[offset] - target[0]) + Math.abs(pixels[offset + 1] - target[1]) + Math.abs(pixels[offset + 2] - target[2]) > tolerance) continue;
        box.count += 1;
        box.minX = Math.min(box.minX, x);
        box.maxX = Math.max(box.maxX, x);
        box.minY = Math.min(box.minY, y);
        box.maxY = Math.max(box.maxY, y);
      }
    }
    return box;
  }

  function pixel(pixels: Buffer, x: number, y: number): number[] {
    const offset = (y * WIDTH + x) * 3;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  }

  async function outputPath(artifactId: string): Promise<string> {
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return join(manifest.value.path, "original.mp4");
  }

  async function renderRevision(revision: string, requestId: string): Promise<NonNullable<Read["render"]>> {
    await call({ op: "render", notebook_id: notebookId, expected_revision: revision, source_hash: sourceHash, request_id: requestId });
    await expect.poll(async () => (await call<Read>({})).render?.status, { timeout: testBudget(300_000), interval: 1000 }).toBe("completed");
    return (await call<Read>({})).render!;
  }

  beforeAll(async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    tempDir = await mkdtemp(join(tmpdir(), "videobook-caption-render-"));
    await queue.start();
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
    const source = join(tempDir, "source.mp4");
    await execFileAsync(FFMPEG, [
      "-y", "-f", "lavfi", "-i", "color=c=0x2060a0:s=640x360:r=30:d=2",
      "-f", "lavfi", "-i", "sine=frequency=330:sample_rate=44100:duration=2",
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", source,
    ]);
    const created = await engine.artifacts.create("video", "skyline");
    if (!created.ok) throw new Error(created.error.message);
    assetId = created.value.artifactId;
    const written = await engine.files.write(assetId, "original.mp4", await readFile(source));
    if (!written.ok) throw new Error(written.error.message);
    await registerMediaProbe(engine, assetId, "original.mp4", await probeVideo(await outputPath(assetId)));
    const transcript = await engine.files.write(assetId, "elevenlabs.json", JSON.stringify(TRANSCRIPT));
    if (!transcript.ok) throw new Error(transcript.error.message);
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    const cell = engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: assetId });
    const saved = await engine.notebooks.write({ ...notebook.value, cells: [cell] });
    if (!saved.ok) throw new Error(saved.error.message);
    await call({ op: "prepare" });
    const deadline = Date.now() + testBudget(60_000);
    while ((await call<Read>({})).status !== "ready") {
      if (Date.now() > deadline) throw new Error("Caption preparation did not finish");
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    sourceHash = (await call<Read>({})).source.media_hash;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) }).catch(() => undefined);
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("renders the reviewed revision into a playable portrait cell whose captions match the layout", async () => {
    const seed = await call<Read>({ detail: "full" });
    const saved = await call<{ revision: string }>({
      op: "update",
      expected_revision: seed.draft!.revision,
      edits: [
        { op: "set_style", style: { snapToOnsets: false, background: "black" } },
        { op: "set_position", y: 0.3 },
        { op: "set_word_timing", word_id: "w3", start: 1.25, end: 1.8 },
      ],
    });
    const requestId = randomUUID();
    const render = await renderRevision(saved.revision, requestId);
    expect(render).toMatchObject({ address: "@b1", error: null });
    const path = await outputPath(render.output_asset_id);
    const probe = await probeVideo(path);
    expect(probe).toMatchObject({ width: WIDTH, height: HEIGHT, hasAudio: true });
    expect(probe.duration).toBeGreaterThan(1.9);
    expect(probe.duration).toBeLessThan(2.15);

    const hello = colorBox(await frame(path, 0.5), HIGHLIGHT, 60);
    const world = colorBox(await frame(path, 1.5), HIGHLIGHT, 60);
    expect(hello.count).toBeGreaterThan(200);
    expect(world.count).toBeGreaterThan(200);
    expect(Math.abs((hello.minY + hello.maxY) / 2 - 0.3 * HEIGHT)).toBeLessThan(60);
    expect((hello.minX + hello.maxX) / 2).toBeLessThan((world.minX + world.maxX) / 2);
    const between = colorBox(await frame(path, 1.22), HIGHLIGHT, 60);
    expect(between.count).toBe(0);

    const padding = pixel(await frame(path, 0.5), 540, 120);
    expect(Math.max(...padding)).toBeLessThan(20);
    const content = pixel(await frame(path, 0.5), 100, 960);
    expect(content[2]).toBeGreaterThan(120);

    const snapshot = await engine.files.read(render.output_asset_id, "captions.json");
    expect(snapshot.ok && (JSON.parse(snapshot.value.toString()) as CaptionDocument).positions).toEqual({ "9:16": 0.3 });
    const provenance = await engine.metadata.artifacts.read<Record<string, unknown>>(render.output_asset_id, "captions");
    expect(provenance.ok && provenance.value).toMatchObject({ sourceArtifactId: assetId, sourceHash, requestId, revision: saved.revision });
    const source = await engine.files.manifest(assetId);
    expect(source.ok && source.value.files.find((file) => file.name === "original.mp4")?.objectHash).toBe(sourceHash);

    const jobsBefore = engine.jobs.queue.list({ type: "render_captions", limit: 50 }).length;
    const retried = await call<{ render: { job_id: number; output_asset_id: string; status: string } }>({
      op: "render", notebook_id: notebookId, expected_revision: saved.revision, source_hash: sourceHash, request_id: requestId,
    });
    expect(retried.render).toMatchObject({ job_id: render.job_id, output_asset_id: render.output_asset_id, status: "completed" });
    expect(engine.jobs.queue.list({ type: "render_captions", limit: 50 })).toHaveLength(jobsBefore);
  });

  it("adds a later render as a version of the same cell and honours phrase overrides", async () => {
    const current = await call<Read>({ detail: "full" });
    const saved = await call<{ revision: string }>({
      op: "update",
      expected_revision: current.draft!.revision,
      edits: [
        { op: "split_phrase", word_id: "w3" },
        { op: "set_style", style: { background: "blur" } },
      ],
    });
    const split = await call<Read>({ detail: "full" });
    const second = split.document.phrases[1].id;
    const positioned = await call<{ revision: string }>({
      op: "update", expected_revision: saved.revision, edits: [{ op: "set_phrase_position", phrase_id: second, y: 0.8 }],
    });
    const before = engine.notebooks.read(notebookId);
    if (!before.ok) throw new Error(before.error.message);
    const firstOutput = before.value.cells.find((cell) => cell.inputs?.sourceOperation === "caption_video");
    const render = await renderRevision(positioned.revision, randomUUID());
    const after = engine.notebooks.read(notebookId);
    if (!after.ok) throw new Error(after.error.message);
    const outputs = after.value.cells.filter((cell) => cell.inputs?.sourceOperation === "caption_video");
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ id: firstOutput?.id, outputArtifactId: render.output_asset_id });
    expect(outputs[0].inputs?.outputVersionArtifactIds).toEqual([firstOutput?.outputArtifactId, render.output_asset_id]);

    const path = await outputPath(render.output_asset_id);
    const world = colorBox(await frame(path, 1.5), HIGHLIGHT, 60);
    expect(Math.abs((world.minY + world.maxY) / 2 - 0.8 * HEIGHT)).toBeLessThan(60);
    const hello = colorBox(await frame(path, 0.5), HIGHLIGHT, 60);
    expect(Math.abs((hello.minY + hello.maxY) / 2 - 0.3 * HEIGHT)).toBeLessThan(60);
    const blurred = pixel(await frame(path, 0.5), 540, 120);
    expect(Math.max(...blurred)).toBeGreaterThan(20);
  });

  it("refuses to render a stale revision or a changed video", async () => {
    const current = await call<Read>({});
    await expect(call({ op: "render", notebook_id: notebookId, expected_revision: "stale", source_hash: sourceHash, request_id: randomUUID() }))
      .rejects.toThrow(/conflict/);
    await expect(call({ op: "render", notebook_id: notebookId, expected_revision: current.draft!.revision, source_hash: "other", request_id: randomUUID() }))
      .rejects.toThrow(/stale_source/);
  });
});
