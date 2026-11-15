import sharp from "sharp";
import type { InferenceSession } from "onnxruntime-node";
import type { CleanupBox } from "./model.js";
import { cleanupSession } from "./models.js";

function boxesFromMap(data: Float32Array, width: number, height: number): CleanupBox[] {
  const visited = new Uint8Array(width * height);
  const queue = new Int32Array(width * height);
  const boxes: CleanupBox[] = [];
  for (let at = 0; at < data.length; at++) {
    if (visited[at] || data[at]! < 0.3) continue;
    let first = 0;
    let last = 1;
    queue[0] = at;
    visited[at] = 1;
    let left = width, right = 0, top = height, bottom = 0, score = 0;
    while (first < last) {
      const i = queue[first++]!;
      const x = i % width, y = Math.floor(i / width);
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
      score += data[i]!;
      const neighbors = [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, y > 0 ? i - width : -1, y + 1 < height ? i + width : -1];
      for (const n of neighbors) {
        if (n < 0 || visited[n] || data[n]! < 0.3) continue;
        visited[n] = 1;
        queue[last++] = n;
      }
    }
    if (score / last < 0.6 || right - left < 4 || bottom - top < 3) continue;
    const padding = Math.ceil((right - left) * (bottom - top) * 1.5 / (2 * (right - left + bottom - top))) + 2;
    const x = Math.max(0, left - padding) / width;
    const y = Math.max(0, top - padding) / height;
    boxes.push({ x, y, width: Math.min(width, right + padding + 1) / width - x, height: Math.min(height, bottom + padding + 1) / height - y });
    if (boxes.length > 200) throw new Error("Too many text candidates in a frame. Use a shorter clip or mark regions manually.");
  }
  return boxes;
}

async function detect(session: InferenceSession, image: Buffer): Promise<CleanupBox[]> {
  const { Tensor } = await import("onnxruntime-node");
  const meta = await sharp(image).metadata();
  const ratio = 960 / Math.max(meta.width!, meta.height!);
  const width = Math.max(32, Math.round(meta.width! * ratio / 32) * 32);
  const height = Math.max(32, Math.round(meta.height! * ratio / 32) * 32);
  const rgb = await sharp(image).resize(width, height, { fit: "fill" }).removeAlpha().toColourspace("srgb").raw().toBuffer();
  const pixels = width * height;
  const input = new Float32Array(3 * pixels);
  const mean = [0.485, 0.456, 0.406], std = [0.229, 0.224, 0.225];
  for (let channel = 0; channel < 3; channel++) {
    for (let i = 0; i < pixels; i++) input[channel * pixels + i] = (rgb[3 * i + 2 - channel]! / 255 - mean[channel]!) / std[channel]!;
  }
  const tensor = new Tensor("float32", input, [1, 3, height, width]);
  let outputs: InferenceSession.ReturnType = {};
  try {
    outputs = await session.run({ [session.inputNames[0]!]: tensor });
    const map = outputs[session.outputNames[0]!]!;
    return boxesFromMap(map.data as Float32Array, Number(map.dims[3]), Number(map.dims[2]));
  } finally {
    tensor.dispose();
    for (const tensor of Object.values(outputs)) tensor.dispose();
  }
}

export async function withCleanupDetector<T>(run: (detect: (image: Buffer) => Promise<CleanupBox[]>) => Promise<T>): Promise<T> {
  const session = await cleanupSession("detector");
  try { return await run((image) => detect(session, image)); } finally { await session.release(); }
}
