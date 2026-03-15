import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { probeImage, cropToFill } from "./image.js";

async function createTestPng(width: number, height: number): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background: { r: 255, g: 0, b: 0, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

describe("image utilities", () => {
  it("probeImage returns correct dimensions", async () => {
    const buf = await createTestPng(10, 20);
    const result = await probeImage(buf);
    expect(result.width).toBe(10);
    expect(result.height).toBe(20);
  });

  it("cropToFill returns a buffer with target dimensions", async () => {
    const buf = await createTestPng(100, 200);
    const cropped = await cropToFill(buf, 50, 50);
    expect(Buffer.isBuffer(cropped)).toBe(true);
    expect(cropped.length).toBeGreaterThan(0);
  });

  it("probeImage on cropToFill result returns target dimensions", async () => {
    const buf = await createTestPng(100, 200);
    const cropped = await cropToFill(buf, 50, 50);
    const result = await probeImage(cropped);
    expect(result.width).toBe(50);
    expect(result.height).toBe(50);
  });

  it("cropToFill handles non-square targets", async () => {
    const buf = await createTestPng(80, 60);
    const cropped = await cropToFill(buf, 30, 20);
    const result = await probeImage(cropped);
    expect(result.width).toBe(30);
    expect(result.height).toBe(20);
  });

  it("cropToFill with upscale target", async () => {
    const buf = await createTestPng(10, 10);
    const cropped = await cropToFill(buf, 50, 30);
    const result = await probeImage(cropped);
    expect(result.width).toBe(50);
    expect(result.height).toBe(30);
  });
});
