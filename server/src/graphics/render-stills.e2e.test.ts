import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import jsQRImport from "jsqr";
import sharp from "sharp";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getSharedBundleLocation } from "../remotion/shared-bundle.js";
import type { GraphicsQrLayout } from "./layout.js";
import { layoutGraphics } from "./layout.js";
import type { GraphicsDocument, GraphicsFrame, GraphicsLayerInput } from "./model.js";
import { graphicsDocumentFromLayers } from "./model.js";
import { renderGraphicsStills } from "./render-stills.js";

const jsQR = jsQRImport as unknown as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

const PORTRAIT: GraphicsFrame = { width: 1080, height: 1920 };
const SMALL: GraphicsFrame = { width: 720, height: 1280 };
const PROFILE_URL = "https://www.tiktok.com/@pomkondeena";

type Raw = { data: Buffer; width: number; height: number };

async function raw(path: string): Promise<Raw> {
  const { data, info } = await sharp(path).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height };
}

function pixel(image: Raw, x: number, y: number): [number, number, number, number] {
  const at = (y * image.width + x) * 4;
  return [image.data[at], image.data[at + 1], image.data[at + 2], image.data[at + 3]];
}

function opaqueRows(image: Raw, top: number, bottom: number): number {
  let rows = 0;
  for (let y = top; y < bottom; y += 1) {
    let opaque = false;
    for (let x = 0; x < image.width && !opaque; x += 1) opaque = pixel(image, x, y)[3] === 255;
    if (opaque) rows += 1;
  }
  return rows;
}

describe("renderGraphicsStills", () => {
  let root: string;
  let outputs = 0;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "videobook-graphics-stills-"));
  });

  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true, maxRetries: 3 });
  });

  async function render(document: GraphicsDocument, frame: GraphicsFrame, images: Parameters<typeof renderGraphicsStills>[0]["images"] = {}) {
    outputs += 1;
    const outputDir = join(root, `out-${outputs}`);
    await mkdir(outputDir);
    return renderGraphicsStills({ document, frame, durationSeconds: 8, images, outputDir, signal: new AbortController().signal });
  }

  it("draws a transparent still that is opaque inside text and graded inside the shade", async () => {
    const document = graphicsDocumentFromLayers([
      { kind: "scrim", edge: "bottom", height: 0.4, color: "#000000", strength: 0.8 },
      { kind: "text", position: { anchor: "top-left", x: 0, y: 0, space: "safe" }, width: 0.8, align: "left", items: [{ text: "HEADLINE", size: 0.08, color: "#FFFFFF", shadow: false }] },
    ]);
    const { groups } = await render(document, PORTRAIT);
    expect(groups).toHaveLength(1);
    const still = await raw(groups[0].path);
    expect([still.width, still.height]).toEqual([1080, 1920]);
    expect(pixel(still, 540, 900)[3]).toBe(0);
    expect(pixel(still, 1060, 400)[3]).toBe(0);
    const shade = [1919, 1536, 1154].map((y) => pixel(still, 1060, y)[3]);
    expect(Math.abs(shade[0] - 204)).toBeLessThanOrEqual(8);
    expect(Math.abs(shade[1] - 102)).toBeLessThanOrEqual(12);
    expect(shade[2]).toBeLessThanOrEqual(8);
    let solid = 0;
    for (let y = 163; y < 268; y += 1) {
      for (let x = 54; x < 700; x += 1) {
        const [red, green, blue, alpha] = pixel(still, x, y);
        if (alpha === 255 && red > 240 && green > 240 && blue > 240) solid += 1;
      }
    }
    expect(solid).toBeGreaterThan(2000);
  });

  it.each([PORTRAIT, SMALL])("draws a tile QR code that decodes to its URL at %j", async (frame) => {
    const document = graphicsDocumentFromLayers([{ kind: "qr", url: PROFILE_URL, style: "tile", size: 0.16 }]);
    const { groups } = await render(document, frame);
    const layout = layoutGraphics({ document, frame, measure: () => 0 }).find((entry): entry is GraphicsQrLayout => entry.kind === "qr");
    const tile = layout?.tile;
    if (!tile) throw new Error("expected a tile");
    expect(pixel(await raw(groups[0].path), tile.x + 1, tile.y + Math.round(tile.height / 2))[3]).toBe(255);
    const { data, info } = await sharp(groups[0].path)
      .extract({ left: tile.x, top: tile.y, width: tile.width, height: tile.height })
      .flatten({ background: "#FFFFFF" })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    expect(jsQR(new Uint8ClampedArray(data), info.width, info.height)?.data).toBe(PROFILE_URL);
  });

  it("renders one still per timing group and draws book images from staged copies", async () => {
    const logoPath = join(root, "logo.png");
    await sharp({ create: { width: 80, height: 40, channels: 4, background: "#E11D48" } }).png().toFile(logoPath);
    const layers: GraphicsLayerInput[] = [
      { kind: "image", artifactId: "logo", position: { anchor: "top-left", x: 0, y: 0, space: "safe" }, size: 0.2 },
      { kind: "text", timing: { tail: 3, fade: 0.5 }, items: [{ text: "Late" }] },
      { kind: "text", items: [{ text: "Credit" }] },
      { kind: "scrim", visible: false },
    ];
    const document = graphicsDocumentFromLayers(layers);
    const { groups } = await render(document, PORTRAIT, { logo: { path: logoPath, width: 80, height: 40 } });
    expect(groups.map((group) => group.layerIds)).toEqual([["l1"], ["l2"], ["l4"]]);
    expect(groups[1].timing).toEqual({ start: 5, end: 8, fadeIn: 0.5, fadeOut: 0, enter: "fade", exit: "fade" });
    expect(new Set(groups.map((group) => group.path)).size).toBe(3);
    const [logo, late, credit] = await Promise.all(groups.map((group) => raw(group.path)));
    const [red, green, blue, alpha] = pixel(logo, 54 + 100, 163 + 50);
    expect(alpha).toBe(255);
    expect(Math.max(Math.abs(red - 225), Math.abs(green - 29), Math.abs(blue - 72))).toBeLessThanOrEqual(3);
    expect(opaqueRows(logo, 780, 880)).toBe(0);
    for (const still of [late, credit]) {
      expect(pixel(still, 54 + 100, 163 + 50)[3]).toBe(0);
      expect(opaqueRows(still, 780, 880)).toBeGreaterThan(10);
    }
    const staged = (await readdir(await getSharedBundleLocation())).filter((name) => name.startsWith("graphics-image-"));
    expect(staged).toEqual([]);
  });

  it("returns before any work for a document with nothing to draw", async () => {
    const aborted = AbortSignal.abort();
    const missing = join(root, "never-created");
    for (const document of [graphicsDocumentFromLayers([]), graphicsDocumentFromLayers([{ kind: "scrim", visible: false }, { kind: "text", items: [{ text: "  " }] }])]) {
      await expect(renderGraphicsStills({ document, frame: PORTRAIT, durationSeconds: 8, images: {}, outputDir: missing, signal: aborted })).resolves.toEqual({ groups: [] });
    }
    await expect(readdir(missing)).rejects.toThrow();
  });
});
