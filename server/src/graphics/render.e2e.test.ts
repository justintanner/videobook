import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import jsQRImport from "jsqr";
import type { Engine, NotebookGridSlot } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { queue, waitForBookQueuesIdleForTests } from "../queue.js";
import { createTestClient } from "../test-client.js";
import { testBudget } from "../test-budget.js";
import type { GraphicsDocument, GraphicsLayerInput } from "./model.js";
import { graphicsDocumentFromLayers } from "./model.js";

const jsQR = jsQRImport as unknown as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;
const execFileAsync = promisify(execFile);
const WIDTH = 720;
const HEIGHT = 1280;
const DURATION = 3;
const PROFILE_URL = "https://www.tiktok.com/@pomkondeena";
const MAGENTA = [255, 0, 255] as const;
const GREEN = [0, 255, 0] as const;
const HALF_GREEN = [16, 176, 80] as const;
const LAYERS: GraphicsLayerInput[] = [
  {
    kind: "text",
    name: "Always",
    position: { anchor: "top-left", x: 0, y: 0, space: "safe" },
    items: [{ text: "ALWAYS", size: 0.06 }],
    plate: { color: "#FF00FF", opacity: 1, radius: 0 },
  },
  {
    kind: "text",
    name: "Window",
    timing: { start: 1, end: 2.5, fade: 0.5 },
    items: [{ text: "WINDOW", size: 0.06 }],
    plate: { color: "#00FF00", opacity: 1, radius: 0 },
  },
  { kind: "qr", name: "Profile", url: PROFILE_URL, style: "tile", size: 0.3, timing: { tail: 1 } },
];

const DRAWN_LAYERS = graphicsDocumentFromLayers(LAYERS).layers.map(({ id, kind, name }) => ({ id, kind, name }));

type Rgb = readonly [number, number, number];
type TextContent = Array<{ type: string; text: string }>;
type RenderStatus = { request_id: string; status: string; job_id: number; output_asset_id: string; cell_id: string | null; address: string | null; error: string | null };
type Burned = { request_id: string; output: string; source_asset_id: string; source_hash: string; rendered_at: string; layers: Array<{ id: string; kind: string; name: string }> };
type Read = { saved: boolean; revision: string; document: GraphicsDocument; source: { source_hash: string }; render: RenderStatus | null; burned: Burned | null };
type Queued = { asset_id: string; job_id: number; status: string; output_artifact_id: string; render: RenderStatus };

function near(pixels: Buffer, offset: number, target: Rgb, tolerance: number): boolean {
  return Math.abs(pixels[offset] - target[0]) + Math.abs(pixels[offset + 1] - target[1]) + Math.abs(pixels[offset + 2] - target[2]) <= tolerance;
}

function colorCount(pixels: Buffer, target: Rgb, tolerance: number): number {
  let count = 0;
  for (let offset = 0; offset < pixels.length; offset += 6) {
    if (near(pixels, offset, target, tolerance)) count += 1;
  }
  return count;
}

function decodeQr(pixels: Buffer): string | null {
  const rgba = new Uint8ClampedArray(WIDTH * HEIGHT * 4);
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    rgba.set([pixels[index * 3], pixels[index * 3 + 1], pixels[index * 3 + 2], 255], index * 4);
  }
  return jsQR(rgba, WIDTH, HEIGHT)?.data ?? null;
}

describe("graphics render", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let notebookId: string;
  let sourceId: string;
  let firstOutput: RenderStatus;
  let clips = 0;
  const bookId = "graphics-render-book";

  async function call<T>(args: Record<string, unknown>): Promise<T> {
    const result = await client.callTool({ name: "video_graphics", arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    if (result.isError) throw new Error(text);
    return JSON.parse(text) as T;
  }

  const read = (assetId: string) => call<Read>({ asset_id: assetId, notebook_id: notebookId });

  async function videoPath(artifactId: string): Promise<string> {
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return join(manifest.value.path, "original.mp4");
  }

  async function fileNames(artifactId: string): Promise<string[]> {
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return manifest.value.files.map((file) => file.name);
  }

  async function sourceHash(artifactId: string): Promise<string | undefined> {
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return manifest.value.files.find((file) => file.name === "original.mp4")?.objectHash;
  }

  async function frame(path: string, seconds: number): Promise<Buffer> {
    const { stdout } = await execFileAsync(FFMPEG, [
      "-v", "error", "-ss", seconds.toFixed(3), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], { encoding: "buffer", maxBuffer: WIDTH * HEIGHT * 4 });
    return stdout;
  }

  async function sourceVideo(label: string, slot: NotebookGridSlot): Promise<string> {
    clips += 1;
    const path = join(tempDir, `source-${clips}.mp4`);
    await execFileAsync(FFMPEG, [
      "-y", "-v", "error",
      "-f", "lavfi", "-i", `color=c=0x2060a0:s=${WIDTH}x${HEIGHT}:r=30:d=${DURATION}`,
      "-f", "lavfi", "-i", `sine=frequency=330:sample_rate=44100:duration=${DURATION}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", path,
    ]);
    const created = await engine.artifacts.create("video", label);
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const written = await engine.files.write(artifactId, "original.mp4", await readFile(path));
    if (!written.ok) throw new Error(written.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(await videoPath(artifactId)));
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = engine.notebooks.createCell({ type: "video", slot, outputArtifactId: artifactId });
    const saved = await engine.notebooks.write({ ...notebook.value, cells: [...notebook.value.cells, cell] });
    if (!saved.ok) throw new Error(saved.error.message);
    return artifactId;
  }

  async function saveLayers(assetId: string, layers: readonly GraphicsLayerInput[]): Promise<{ revision: string; sourceHash: string }> {
    const fresh = await read(assetId);
    const saved = await call<{ revision: string }>({ asset_id: assetId, op: "update", expected_revision: fresh.revision, document: graphicsDocumentFromLayers(layers) });
    return { revision: saved.revision, sourceHash: fresh.source.source_hash };
  }

  async function renderAndWait(assetId: string, args: Record<string, unknown>): Promise<{ queued: Queued; render: RenderStatus }> {
    const queued = await call<Queued>({ asset_id: assetId, op: "render", notebook_id: notebookId, ...args });
    await expect.poll(async () => (await read(assetId)).render?.status, { timeout: testBudget(300_000), interval: 1000 }).toBe("completed");
    return { queued, render: (await read(assetId)).render! };
  }

  function graphicsCells() {
    const notebook = engine.notebooks.read(notebookId);
    if (!notebook.ok) throw new Error(notebook.error.message);
    return { all: notebook.value.cells, outputs: notebook.value.cells.filter((cell) => cell.inputs?.sourceOperation === "video_graphics") };
  }

  beforeAll(async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    tempDir = await mkdtemp(join(tmpdir(), "videobook-graphics-render-e2e-"));
    await queue.start();
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
    const notebook = await engine.notebooks.create("Main");
    if (!notebook.ok) throw new Error(notebook.error.message);
    notebookId = notebook.value.id;
    sourceId = await sourceVideo("street", { row: 0, column: 0 });
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) }).catch(() => undefined);
    await client?.close();
    await queue.stop();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("renders the reviewed graphics into a new connected cell, each layer only inside its window", async () => {
    const reviewed = await saveLayers(sourceId, LAYERS);
    const requestId = randomUUID();
    const { queued, render } = await renderAndWait(sourceId, { expected_revision: reviewed.revision, source_hash: reviewed.sourceHash, request_id: requestId });
    expect(["queued", "running"]).toContain(queued.status);
    expect(render).toMatchObject({ request_id: requestId, job_id: queued.job_id, output_asset_id: queued.output_artifact_id, address: "@b1", error: null });
    firstOutput = render;

    const { outputs } = graphicsCells();
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ id: render.cell_id, type: "video", outputArtifactId: render.output_asset_id, inputs: { sourceArtifactId: sourceId, state: "completed" } });
    expect(await sourceHash(sourceId)).toBe(reviewed.sourceHash);

    const path = await videoPath(render.output_asset_id);
    const [sourceProbe, outputProbe] = await Promise.all([probeVideo(await videoPath(sourceId)), probeVideo(path)]);
    expect(outputProbe).toMatchObject({ width: WIDTH, height: HEIGHT, hasAudio: true });
    expect(Math.abs(outputProbe.duration - sourceProbe.duration)).toBeLessThan(0.2);
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(120_000) });
    const outputFiles = await fileNames(render.output_asset_id);
    expect(outputFiles).toEqual(expect.arrayContaining(["original.mp4", "original.jpg", "graphics.json", "proxy.mp4", "original.mp3"]));
    expect(outputFiles.filter((name) => name.startsWith("original_frames/")).length).toBeGreaterThan(0);

    const early = await frame(path, 0.5);
    expect(colorCount(early, MAGENTA, 60)).toBeGreaterThan(500);
    expect(colorCount(early, GREEN, 120)).toBe(0);
    expect(decodeQr(early)).toBeNull();
    const fading = await frame(path, 1.25);
    expect(colorCount(fading, HALF_GREEN, 50)).toBeGreaterThan(300);
    expect(colorCount(fading, GREEN, 60)).toBe(0);
    const middle = await frame(path, 1.75);
    expect(colorCount(middle, GREEN, 60)).toBeGreaterThan(300);
    expect(colorCount(middle, MAGENTA, 60)).toBeGreaterThan(500);
    expect(decodeQr(middle)).toBeNull();
    const late = await frame(path, 2.75);
    expect(colorCount(late, GREEN, 120)).toBe(0);
    expect(colorCount(late, MAGENTA, 60)).toBeGreaterThan(500);
    expect(decodeQr(late)).toBe(PROFILE_URL);

    const provenance = await engine.metadata.artifacts.read<Record<string, unknown>>(render.output_asset_id, "graphics");
    expect(provenance.ok && provenance.value).toMatchObject({
      requestId,
      sourceArtifactId: sourceId,
      sourceHash: reviewed.sourceHash,
      output: "new",
      layers: DRAWN_LAYERS,
    });
    const snapshot = await engine.files.read(render.output_asset_id, "graphics.json");
    expect(snapshot.ok && (JSON.parse(snapshot.value.toString()) as GraphicsDocument).layers.map((layer) => layer.name)).toEqual(["Always", "Window", "Profile"]);
    expect((await call<Read>({ asset_id: render.output_asset_id })).burned).toMatchObject({ request_id: requestId, output: "new", source_asset_id: sourceId });

    const jobsBefore = engine.jobs.queue.list({ type: "render_graphics", limit: 50 }).length;
    const retried = await call<Queued>({ asset_id: sourceId, op: "render", notebook_id: notebookId, expected_revision: reviewed.revision, source_hash: reviewed.sourceHash, request_id: requestId });
    expect(retried.render).toMatchObject({ job_id: queued.job_id, output_asset_id: render.output_asset_id, status: "completed" });
    expect(engine.jobs.queue.list({ type: "render_graphics", limit: 50 })).toHaveLength(jobsBefore);
  });

  it("adds a later render as a version of the same cell", async () => {
    const reviewed = await saveLayers(sourceId, [LAYERS[0]]);
    const cellsBefore = graphicsCells().all.length;
    const { render } = await renderAndWait(sourceId, { expected_revision: reviewed.revision, source_hash: reviewed.sourceHash, request_id: randomUUID() });
    expect(render.output_asset_id).not.toBe(firstOutput.output_asset_id);
    const { all, outputs } = graphicsCells();
    expect(all).toHaveLength(cellsBefore);
    expect(outputs).toHaveLength(1);
    expect(outputs[0]).toMatchObject({ id: firstOutput.cell_id, outputArtifactId: render.output_asset_id });
    expect(outputs[0].inputs?.outputVersionArtifactIds).toEqual([firstOutput.output_asset_id, render.output_asset_id]);
    expect(render).toMatchObject({ cell_id: firstOutput.cell_id, address: "@b1" });
    const late = await frame(await videoPath(render.output_asset_id), 2.75);
    expect(colorCount(late, MAGENTA, 60)).toBeGreaterThan(500);
    expect(decodeQr(late)).toBeNull();
  });

  it("burns the graphics into the source in place, reprocesses it and clears the draft", async () => {
    const inPlace = await sourceVideo("in place", { row: 0, column: 2 });
    const reviewed = await saveLayers(inPlace, LAYERS);
    const cellsBefore = graphicsCells().all;
    const historyOf = async () => JSON.parse(((await client.callTool({ name: "asset_history", arguments: { book_id: bookId, asset_id: inPlace } })).content as TextContent)[0].text) as Array<{ hash: string }>;
    const before = await historyOf();
    const requestId = randomUUID();
    const { queued, render } = await renderAndWait(inPlace, { output: "replace", expected_revision: reviewed.revision, source_hash: reviewed.sourceHash, request_id: requestId });
    expect(queued).toMatchObject({ asset_id: inPlace, output_artifact_id: inPlace });
    const sourceCell = cellsBefore.find((cell) => cell.outputArtifactId === inPlace);
    expect(render).toMatchObject({ output_asset_id: inPlace, cell_id: sourceCell?.id, address: "@a3", error: null });
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(120_000) });

    expect(graphicsCells().all).toHaveLength(cellsBefore.length);
    expect(await sourceHash(inPlace)).not.toBe(reviewed.sourceHash);
    expect(await fileNames(inPlace)).toEqual(expect.arrayContaining(["original.mp4", "proxy.mp4", "graphics.json"]));
    expect((await historyOf()).length).toBeGreaterThan(before.length);
    expect(engine.settings.get(`graphics.draft.${inPlace}`)).toBeNull();
    const after = await read(inPlace);
    expect(after).toMatchObject({ saved: false, render: { request_id: requestId, status: "completed" } });
    expect(after.burned).toMatchObject({ request_id: requestId, output: "replace", source_asset_id: inPlace, source_hash: reviewed.sourceHash });
    expect(after.burned?.layers).toEqual(DRAWN_LAYERS);

    const path = await videoPath(inPlace);
    expect(await probeVideo(path)).toMatchObject({ width: WIDTH, height: HEIGHT, hasAudio: true });
    const late = await frame(path, 2.75);
    expect(colorCount(late, MAGENTA, 60)).toBeGreaterThan(500);
    expect(decodeQr(late)).toBe(PROFILE_URL);
    expect(colorCount(await frame(path, 0.5), GREEN, 120)).toBe(0);
  });
});
