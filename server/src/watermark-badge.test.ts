import { describe, expect, it } from "vitest";
import sharp from "sharp";
import jsQRImport from "jsqr";

const jsQR = jsQRImport as unknown as (
  data: Uint8ClampedArray,
  width: number,
  height: number,
  options?: { inversionAttempts?: string },
) => { data: string } | null;
import {
  BADGE_ASPECT,
  BADGE_HEIGHT,
  BADGE_WIDTH,
  buildWatermarkBadgePng,
  defaultUrl,
} from "./watermark-badge.js";
import { WATERMARK_MIN_DIM_FRACTION, WATERMARK_OPACITY } from "./remotion/osg-spec.js";

const URL = "https://x.com/someone";

async function decodeQr(png: Buffer): Promise<string | null> {
  const { data, info } = await sharp(png)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const decoded = jsQR(new Uint8ClampedArray(data), info.width, info.height);
  return decoded?.data ?? null;
}

/** Deterministic mid-contrast noise so the composite resembles busy footage. */
function noisyBackground(width: number, height: number): Buffer {
  const pixels = Buffer.alloc(width * height * 3);
  let seed = 0x2f6e2b1;
  for (let i = 0; i < pixels.length; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    pixels[i] = 40 + (seed % 176);
  }
  return pixels;
}

describe("buildWatermarkBadgePng", () => {
  it("renders a transparent badge at the documented dimensions", async () => {
    const badge = await buildWatermarkBadgePng(URL, "someone");
    const metadata = await sharp(badge).metadata();
    expect(metadata.width).toBe(BADGE_WIDTH);
    expect(metadata.height).toBe(BADGE_HEIGHT);
    expect(metadata.hasAlpha).toBe(true);
    expect(BADGE_ASPECT).toBeCloseTo(BADGE_WIDTH / BADGE_HEIGHT, 6);

    // Corners outside the tile/pill must be fully transparent.
    const raw = await sharp(badge).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const alphaAt = (x: number, y: number) => raw.data[(y * raw.info.width + x) * 4 + 3];
    expect(alphaAt(BADGE_WIDTH - 1, 0)).toBe(0);
    expect(alphaAt(BADGE_WIDTH - 1, 470)).toBe(0);
  });

  it("decodes at full size", async () => {
    const badge = await buildWatermarkBadgePng(URL, "someone");
    expect(await decodeQr(badge)).toBe(URL);
  });

  it("stays scannable at 50% opacity over busy footage at on-screen size", async () => {
    const badge = await buildWatermarkBadgePng(URL, "someone");
    // On-screen size: badge height = min-dim fraction of a 1080 canvas.
    const onScreenHeight = Math.round(1080 * WATERMARK_MIN_DIM_FRACTION);
    const onScreenWidth = Math.round(onScreenHeight * BADGE_ASPECT);
    const faint = await sharp(badge)
      .resize({ width: onScreenWidth, height: onScreenHeight, fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .ensureAlpha(WATERMARK_OPACITY)
      .png()
      .toBuffer();
    const canvasWidth = onScreenWidth + 80;
    const canvasHeight = onScreenHeight + 80;
    const compositeOver = async (blur: number) => {
      let background = sharp(noisyBackground(canvasWidth, canvasHeight), {
        raw: { width: canvasWidth, height: canvasHeight, channels: 3 },
      });
      if (blur > 0) background = background.blur(blur);
      return background.composite([{ input: faint, left: 40, top: 40 }]).png().toBuffer();
    };
    const upscale = async (png: Buffer, factor: number) => sharp(png)
      .resize({ width: canvasWidth * factor, kernel: "nearest" })
      .png()
      .toBuffer();

    // Real footage is locally smooth: mild blur over the noise, 3× capture.
    const footageLike = await compositeOver(1.5);
    expect(await decodeQr(await upscale(footageLike, 3))).toBe(URL);

    // Worst case — raw per-pixel noise — still decodes at a closer 4× capture.
    const rawNoise = await compositeOver(0);
    expect(await decodeQr(await upscale(rawNoise, 4))).toBe(URL);
  });

  it("clamps long handles inside the pill", async () => {
    const badge = await buildWatermarkBadgePng(URL, "a-very-long-handle-name-x");
    const metadata = await sharp(badge).metadata();
    expect(metadata.width).toBe(BADGE_WIDTH);
    expect(metadata.height).toBe(BADGE_HEIGHT);
  });

  it("derives the default URL from the handle", () => {
    expect(defaultUrl("someone")).toBe("https://x.com/someone");
  });
});
