import sharp from "sharp";
import type { InferenceSession } from "onnxruntime-node";
import { cleanupPixelBox, type CleanupRegion } from "./model.js";
import { cleanupSession } from "./models.js";

const SIDE = 512;
const PIXELS = SIDE * SIDE;

async function paint(session: InferenceSession, frame: Buffer, width: number, height: number, regions: readonly CleanupRegion[]): Promise<Buffer> {
  const { Tensor } = await import("onnxruntime-node");
  const boxes = regions.map((r) => cleanupPixelBox(r, width, height));
  const output = Buffer.from(frame);
  for (const box of boxes) {
    const context = Math.max(32, Math.round(Math.max(box.width, box.height) * 0.4));
    const side = Math.max(box.width, box.height) + context * 2;
    const left = Math.max(0, Math.min(width - Math.min(side, width), Math.floor(box.left + box.width / 2 - side / 2)));
    const top = Math.max(0, Math.min(height - Math.min(side, height), Math.floor(box.top + box.height / 2 - side / 2)));
    const crop = { left, top, width: Math.min(side, width), height: Math.min(side, height) };
    const rgb = await sharp(output, { raw: { width, height, channels: 3 } }).extract(crop).resize(SIDE, SIDE, { fit: "fill" }).raw().toBuffer();
    const input = new Float32Array(3 * PIXELS);
    const mask = new Float32Array(PIXELS);
    for (let i = 0; i < PIXELS; i++) {
      for (let c = 0; c < 3; c++) input[c * PIXELS + i] = rgb[i * 3 + c]! / 255;
      const x = crop.left + (i % SIDE + 0.5) / SIDE * crop.width;
      const y = crop.top + (Math.floor(i / SIDE) + 0.5) / SIDE * crop.height;
      mask[i] = boxes.some((b) => x >= b.left && x < b.left + b.width && y >= b.top && y < b.top + b.height) ? 1 : 0;
    }
    const imageTensor = new Tensor("float32", input, [1, 3, SIDE, SIDE]);
    const maskTensor = new Tensor("float32", mask, [1, 1, SIDE, SIDE]);
    let results: InferenceSession.ReturnType = {};
    try {
      results = await session.run({ image: imageTensor, mask: maskTensor });
      const values = results[session.outputNames[0]!]!.data as Float32Array;
      const pixels = Buffer.alloc(PIXELS * 3);
      for (let i = 0; i < PIXELS; i++) {
        for (let c = 0; c < 3; c++) pixels[i * 3 + c] = Math.max(0, Math.min(255, Math.round(values[c * PIXELS + i]!)));
      }
      const restored = await sharp(pixels, { raw: { width: SIDE, height: SIDE, channels: 3 } }).resize(crop.width, crop.height).raw().toBuffer();
      for (let y = box.top; y < box.top + box.height; y++) {
        const from = ((y - top) * crop.width + box.left - left) * 3;
        restored.copy(output, (y * width + box.left) * 3, from, from + box.width * 3);
      }
    } finally {
      imageTensor.dispose(); maskTensor.dispose();
      for (const tensor of Object.values(results)) tensor.dispose();
    }
  }
  return output;
}

export async function withCleanupInpainter<T>(run: (paint: (frame: Buffer, width: number, height: number, regions: readonly CleanupRegion[]) => Promise<Buffer>) => Promise<T>): Promise<T> {
  const session = await cleanupSession("lama");
  try { return await run((frame, width, height, regions) => paint(session, frame, width, height, regions)); } finally { await session.release(); }
}
