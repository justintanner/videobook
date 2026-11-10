import jsQRImport from "jsqr";
import { describe, expect, it } from "vitest";
import { qrMatrix } from "./qr.js";

const jsQR = jsQRImport as unknown as (data: Uint8ClampedArray, width: number, height: number) => { data: string } | null;

const URL = "https://www.tiktok.com/@pomkondeena";
const SCALE = 6;
const QUIET = 4;

function rasterize(size: number, dark: readonly boolean[]): { data: Uint8ClampedArray; side: number } {
  const side = (size + 2 * QUIET) * SCALE;
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let y = 0; y < side; y += 1) {
    for (let x = 0; x < side; x += 1) {
      const row = Math.floor(y / SCALE) - QUIET;
      const column = Math.floor(x / SCALE) - QUIET;
      if (row < 0 || column < 0 || row >= size || column >= size || !dark[row * size + column]) continue;
      data.fill(0, (y * side + x) * 4, (y * side + x) * 4 + 3);
    }
  }
  return { data, side };
}

describe("qrMatrix", () => {
  it.each(["L", "M", "Q", "H"] as const)("gives a square module grid that decodes to its URL at level %s", (level) => {
    const matrix = qrMatrix(URL, level);
    expect((matrix.size - 21) % 4).toBe(0);
    expect(matrix.dark).toHaveLength(matrix.size * matrix.size);
    const { data, side } = rasterize(matrix.size, matrix.dark);
    expect(jsQR(data, side, side)?.data).toBe(URL);
  });

  it("grows with the error correction level and is the same for the same input", () => {
    expect(qrMatrix(URL, "H").size).toBeGreaterThan(qrMatrix(URL, "L").size);
    expect(qrMatrix(URL, "H")).toEqual(qrMatrix(URL, "H"));
    expect(qrMatrix("https://x.com/justinwtanner", "H").dark).not.toEqual(qrMatrix(URL, "H").dark);
  });
});
