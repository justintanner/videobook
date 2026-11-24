import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Client } from "@modelcontextprotocol/client";
import sharp from "sharp";
import type { Engine } from "videobook-engine";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEngineForTest } from "../engine.js";
import { FFMPEG, probeVideo } from "../ffmpeg.js";
import type { GraphicsDocument, GraphicsImageLayer } from "../graphics/model.js";
import { readGraphicsTemplates } from "../graphics/templates.js";
import { registerMediaProbe } from "../notebook-media-ops.js";
import { createTestClient } from "../test-client.js";

const execFileAsync = promisify(execFile);

type TextContent = Array<{ type: string; text: string }>;
type Logo = { asset_id: string; position: { anchor: string; x: number; y: number; space: string }; size: number; opacity: number };
type Read = { revision: string; saved: boolean; document: GraphicsDocument; logo: Logo | null; images: Record<string, { url: string | null }>; starters: Array<{ id: string; document: GraphicsDocument }> };
type Saved = { revision: string; document: GraphicsDocument };
type Listed = { status: string; logo: Logo | null };
type Failure = { status: string; message: string };

function logoLayers(document: GraphicsDocument): GraphicsImageLayer[] {
  return document.layers.filter((layer): layer is GraphicsImageLayer => layer.kind === "image" && layer.role === "logo");
}

describe("video_graphics book logo", () => {
  let client: Client;
  let engine: Engine;
  let tempDir: string;
  let clips = 0;
  const bookId = "video-graphics-logo-book";

  async function video(): Promise<string> {
    clips += 1;
    const output = join(tempDir, `clip-${clips}.mp4`);
    await execFileAsync(FFMPEG, ["-y", "-f", "lavfi", "-i", "color=c=gray:s=360x640:r=24:d=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-an", output]);
    const created = await engine.artifacts.create("video", "kratong");
    if (!created.ok) throw new Error(created.error.message);
    const artifactId = created.value.artifactId;
    const written = await engine.files.write(artifactId, "original.mp4", await readFile(output));
    if (!written.ok) throw new Error(written.error.message);
    const manifest = await engine.files.manifest(artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    await registerMediaProbe(engine, artifactId, "original.mp4", await probeVideo(join(manifest.value.path, "original.mp4")));
    return artifactId;
  }

  async function image(): Promise<string> {
    const created = await engine.artifacts.create("image", "jtbkk");
    if (!created.ok) throw new Error(created.error.message);
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 4, background: "#9AAEBB" } }).png().toBuffer();
    const written = await engine.files.write(created.value.artifactId, "original.png", bytes);
    if (!written.ok) throw new Error(written.error.message);
    const original = await engine.metadata.artifacts.write(created.value.artifactId, "original", { origin: "upload", width: 64, height: 64 });
    if (!original.ok) throw new Error(original.error.message);
    return created.value.artifactId;
  }

  async function call(args: Record<string, unknown>): Promise<{ error: boolean; body: unknown; text: string }> {
    const result = await client.callTool({ name: "video_graphics", arguments: { book_id: bookId, ...args } });
    const text = (result.content as TextContent)[0].text;
    try {
      return { error: result.isError === true, body: JSON.parse(text), text };
    } catch {
      return { error: result.isError === true, body: null, text };
    }
  }

  async function ok<T>(args: Record<string, unknown>): Promise<T> {
    const result = await call(args);
    if (result.error) throw new Error(result.text);
    return result.body as T;
  }

  async function fails(args: Record<string, unknown>): Promise<Failure> {
    const result = await call(args);
    expect(result.error, result.text).toBe(true);
    return result.body as Failure;
  }

  async function cellAt(artifactId: string, row: number, column: number): Promise<string> {
    const notebook = await engine.notebooks.create(`Logo ${randomUUID()}`);
    if (!notebook.ok) throw new Error(notebook.error.message);
    const cell = engine.notebooks.createCell({ type: "image", slot: { row, column }, outputArtifactId: artifactId });
    const written = await engine.notebooks.write({ ...notebook.value, cells: [cell] });
    if (!written.ok) throw new Error(written.error.message);
    return notebook.value.id;
  }

  beforeAll(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "videobook-graphics-logo-"));
    client = await createTestClient(tempDir);
    engine = createEngineForTest(tempDir);
    await client.callTool({ name: "create_project", arguments: { book_id: bookId } });
  });

  afterAll(async () => {
    await client?.close();
    if (tempDir) await rm(tempDir, { recursive: true, force: true, maxRetries: 3 });
  });

  it("starts new videos with the book's logo over the default look, keeps it through templates and never saves it in one", async () => {
    const logoId = await image();
    const notebookId = await cellAt(logoId, 2, 1);
    const before = await video();
    const plain = await ok<Read>({ asset_id: before });
    expect(plain.logo).toBeNull();
    expect(logoLayers(plain.document)).toEqual([]);

    const set = await ok<Listed>({ op: "set_logo", notebook_id: notebookId, logo: { asset_id: "@c2", size: 0.155, opacity: 0.55 } });
    expect(set).toMatchObject({ status: "saved", logo: { asset_id: logoId, size: 0.155, opacity: 0.55, position: { anchor: "bottom-right", x: 1, y: 1, space: "safe" } } });

    const fresh = await video();
    const opened = await ok<Read>({ asset_id: fresh });
    expect(opened.saved).toBe(false);
    expect(opened.logo).toMatchObject({ asset_id: logoId, size: 0.155 });
    expect(opened.document.layers.at(-1)).toMatchObject({ kind: "image", role: "logo", name: "Logo", artifactId: logoId, size: 0.155, opacity: 0.55 });
    expect(opened.document.layers.slice(0, -1).map((layer) => layer.kind)).toEqual(["scrim", "text"]);
    expect(opened.images[logoId]?.url).toMatch(new RegExp(`/${logoId}/original\\.png`, "u"));

    const headline = opened.starters.find((starter) => starter.id === "headline")!.document;
    const restyled = await ok<Saved>({ asset_id: fresh, op: "update", expected_revision: opened.revision, edits: [{ op: "apply_template", template: headline }] });
    expect(logoLayers(restyled.document)).toHaveLength(1);
    expect(restyled.document.layers.at(-1)).toMatchObject({ role: "logo", artifactId: logoId });

    await ok({ asset_id: fresh, op: "save_template", name: "Kratong look", expected_revision: restyled.revision });
    const saved = readGraphicsTemplates(engine).templates.find((template) => template.name === "Kratong look");
    expect(saved?.document.layers.map((layer) => layer.kind)).toEqual(["scrim", "text"]);

    const moved = await ok<Saved>({
      asset_id: fresh,
      op: "update",
      expected_revision: restyled.revision,
      edits: [{ op: "set_position", layer_id: restyled.document.layers.at(-1)!.id, position: { anchor: "top-left", x: 0, y: 0, space: "safe" } }],
    });
    expect(moved.document.layers.at(-1)).toMatchObject({ role: "logo", position: { anchor: "top-left" } });
    const untouched = await ok<Read>({ asset_id: before });
    expect(untouched.logo?.position.anchor).toBe("bottom-right");
    expect(untouched.document.layers.at(-1)).toMatchObject({ role: "logo", position: { anchor: "bottom-right" } });
  });

  it("refuses a logo that is not a valid image and clears it with null or when the image is forgotten", async () => {
    const clip = await video();
    expect(await fails({ op: "set_logo", logo: { asset_id: clip } })).toMatchObject({ status: "invalid", message: expect.stringContaining("is not an image in this book") });
    const logoId = await image();
    expect(await fails({ op: "set_logo", logo: { asset_id: logoId, size: 5 } })).toMatchObject({ status: "invalid", message: expect.stringContaining("Image size must be between 0.02 and 1") });
    expect((await fails({ op: "set_logo" })).message).toContain("set_logo needs logo");

    await ok({ op: "set_logo", logo: { asset_id: logoId } });
    expect((await ok<Read>({ asset_id: clip })).logo).toMatchObject({ asset_id: logoId, size: 0.15, opacity: 0.8 });
    expect(await ok<Listed>({ op: "set_logo", logo: null })).toMatchObject({ status: "saved", logo: null });
    const cleared = await ok<Read>({ asset_id: await video() });
    expect(cleared.logo).toBeNull();
    expect(logoLayers(cleared.document)).toEqual([]);

    await ok({ op: "set_logo", logo: { asset_id: logoId } });
    const forgotten = await client.callTool({ name: "delete_asset", arguments: { book_id: bookId, asset_id: logoId, forget: true } });
    expect(forgotten.isError).not.toBe(true);
    expect((await ok<Read>({ asset_id: await video() })).logo).toBeNull();
  });
});
