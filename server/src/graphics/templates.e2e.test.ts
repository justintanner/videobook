import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { ManagedBook } from "../book-manager.js";
import { BookManager } from "../book-manager.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import { registerAllJobHandlers } from "../jobs/index.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { queue, setEngineRoot, waitForBookQueuesIdleForTests } from "../queue.js";
import { testBudget } from "../test-budget.js";
import type { ToolDef } from "../tools/tool-def.js";
import { videoGraphicsDef } from "../tools/video-graphics.js";
import type { GraphicsDocument } from "./model.js";
import { graphicsDocumentFromLayers } from "./model.js";
import { saveGraphicsTemplate } from "./templates.js";

const execFileAsync = promisify(execFile);
const WIDTH = 720;
const HEIGHT = 1280;
const DURATION = 2;
const MAGENTA = [255, 0, 255] as const;

type Rgb = readonly [number, number, number];
type Template = { id: string; name: string; document: GraphicsDocument; missing_layer_ids: string[] };
type Read = { revision: string; document: GraphicsDocument; templates: Template[]; images: Record<string, { url: string | null }>; source: { source_hash: string }; render: { status: string; output_asset_id: string; error: string | null } | null };

function near(pixels: Buffer, offset: number, target: Rgb, tolerance: number): boolean {
  return Math.abs(pixels[offset] - target[0]) + Math.abs(pixels[offset + 1] - target[1]) + Math.abs(pixels[offset + 2] - target[2]) <= tolerance;
}

function colorBox(pixels: Buffer, target: Rgb, tolerance: number) {
  const box = { count: 0, minX: WIDTH, minY: HEIGHT, maxX: -1, maxY: -1 };
  for (let index = 0; index < WIDTH * HEIGHT; index += 1) {
    if (!near(pixels, index * 3, target, tolerance)) continue;
    const x = index % WIDTH;
    const y = Math.floor(index / WIDTH);
    box.count += 1;
    box.minX = Math.min(box.minX, x);
    box.minY = Math.min(box.minY, y);
    box.maxX = Math.max(box.maxX, x);
    box.maxY = Math.max(box.maxY, y);
  }
  return box;
}

describe("graphics templates copied between books", () => {
  let tempDir: string;
  let books: BookManager;
  let brand: ManagedBook;
  let daily: ManagedBook;
  let tool: ToolDef;

  async function call<T>(args: Record<string, unknown>): Promise<T> {
    const result = await tool.handler({ book_id: daily.bookId, ...args });
    if (result.isError) throw new Error(result.content[0].text);
    return JSON.parse(result.content[0].text) as T;
  }

  async function videoPath(engine: Engine, artifactId: string): Promise<string> {
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    return join(manifest.value.path, "original.mp4");
  }

  async function sourceVideo(engine: Engine): Promise<{ artifactId: string; notebookId: string }> {
    const path = join(tempDir, "street.mp4");
    await execFileAsync(FFMPEG, [
      "-y", "-v", "error", "-f", "lavfi", "-i", `color=c=0x2060a0:s=${WIDTH}x${HEIGHT}:r=30:d=${DURATION}`,
      "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", path,
    ]);
    const created = await engine.artifacts.create("video", "street");
    if (!created.ok) throw new Error(created.error.message);
    const written = await engine.files.writeFromPath(created.value.artifactId, "original.mp4", path);
    if (!written.ok) throw new Error(written.error.message);
    await registerMediaProbe(engine, created.value.artifactId, "original.mp4", await probeVideo(await videoPath(engine, created.value.artifactId)));
    const notebook = engine.notebooks.list()[0];
    const inserted = await engine.notebooks.insertCell(notebook.id, engine.notebooks.createCell({ type: "video", slot: { row: 0, column: 0 }, outputArtifactId: created.value.artifactId }));
    if (!inserted.ok) throw new Error(inserted.error.message);
    return { artifactId: created.value.artifactId, notebookId: notebook.id };
  }

  async function logo(engine: Engine): Promise<string> {
    const created = await engine.artifacts.create("image", "brand logo");
    if (!created.ok) throw new Error(created.error.message);
    const bytes = await sharp({ create: { width: 200, height: 100, channels: 4, background: "#FF00FF" } }).png().toBuffer();
    const written = await engine.files.write(created.value.artifactId, "original.png", bytes);
    if (!written.ok) throw new Error(written.error.message);
    const original = await engine.metadata.artifacts.write(created.value.artifactId, "original", { origin: "upload", width: 200, height: 100 });
    if (!original.ok) throw new Error(original.error.message);
    return created.value.artifactId;
  }

  beforeAll(async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    vi.stubEnv("ELEVENLABS_API_KEY", "");
    tempDir = await mkdtemp(join(tmpdir(), "videobook-graphics-templates-e2e-"));
    books = new BookManager({ libraryDir: join(tempDir, "books"), objectPrefix: "test-objects", catalogBackupName: "backup" });
    await books.ready();
    const brandCreated = await books.create("brand-kit");
    const dailyCreated = await books.create("daily-trends");
    if (!brandCreated.ok || !dailyCreated.ok) throw new Error("Could not create test books");
    const brandBook = books.get(brandCreated.value.bookId);
    const dailyBook = books.get(dailyCreated.value.bookId);
    if (!brandBook.ok || !dailyBook.ok) throw new Error("Could not load test books");
    brand = brandBook.value;
    daily = dailyBook.value;
    registerAllJobHandlers(daily.engine, books);
    await setEngineRoot(daily.rootDir, daily.engine);
    tool = videoGraphicsDef(daily.engine, books);
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await waitForBookQueuesIdleForTests({ budgetMs: testBudget(30_000) }).catch(() => undefined);
    await queue.stop();
    await books?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("brings the template's logo into the other book, where the applied template renders it", async () => {
    const brandLogo = await logo(brand.engine);
    await saveGraphicsTemplate(brand.engine, {
      name: "Brand kit",
      document: graphicsDocumentFromLayers([
        { kind: "image", name: "Logo", artifactId: brandLogo, position: { anchor: "top-left", x: 0, y: 0, space: "inset" }, size: 0.3 },
        { kind: "text", name: "Title", position: { anchor: "bottom-left", x: 0, y: 1, space: "safe" }, align: "left", items: [{ slot: "headline", text: "", size: 0.08 }] },
      ]),
    });
    const { artifactId, notebookId } = await sourceVideo(daily.engine);

    const copy = await call<{ copied: Array<{ id: string }>; images: Array<{ source_asset_id: string; asset_id: string }> }>({ op: "copy_templates", from_book: "brand-kit" });
    expect(copy.images).toEqual([{ source_asset_id: brandLogo, asset_id: expect.any(String) }]);
    const copiedLogo = copy.images[0].asset_id;

    const fresh = await call<Read>({ asset_id: artifactId, notebook_id: notebookId });
    const template = fresh.templates.find((candidate) => candidate.id === copy.copied[0].id);
    expect(template).toMatchObject({ name: "Brand kit", missing_layer_ids: [] });
    expect(template?.document.layers[0]).toMatchObject({ kind: "image", artifactId: copiedLogo });
    expect(fresh.images[copiedLogo]?.url).toMatch(new RegExp(`^/files/${daily.bookId}/${copiedLogo}/`, "u"));

    const applied = await call<{ revision: string }>({
      asset_id: artifactId,
      notebook_id: notebookId,
      op: "update",
      expected_revision: fresh.revision,
      edits: [{ op: "apply_template", template: template?.document }, { op: "set_slot_text", slot: "headline", text: "Copied look" }],
    });
    await call({ asset_id: artifactId, notebook_id: notebookId, op: "render", expected_revision: applied.revision, source_hash: fresh.source.source_hash, request_id: randomUUID() });
    await expect.poll(async () => (await call<Read>({ asset_id: artifactId, notebook_id: notebookId })).render?.status, { timeout: testBudget(300_000), interval: 1000 }).toBe("completed");
    const render = (await call<Read>({ asset_id: artifactId, notebook_id: notebookId })).render;
    expect(render?.error).toBeNull();

    const { stdout } = await execFileAsync(FFMPEG, [
      "-v", "error", "-ss", "1", "-i", await videoPath(daily.engine, render!.output_asset_id), "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1",
    ], { encoding: "buffer", maxBuffer: WIDTH * HEIGHT * 4 });
    const box = colorBox(stdout, MAGENTA, 60);
    const inset = WIDTH * 0.02;
    const logoWidth = WIDTH * 0.3;
    expect(box.count).toBeGreaterThan(logoWidth * logoWidth * 0.5 * 0.8);
    expect(Math.abs(box.minX - inset)).toBeLessThanOrEqual(3);
    expect(Math.abs(box.minY - inset)).toBeLessThanOrEqual(3);
    expect(Math.abs(box.maxX + 1 - inset - logoWidth)).toBeLessThanOrEqual(3);
  });
});
