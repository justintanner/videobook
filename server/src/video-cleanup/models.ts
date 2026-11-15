import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream } from "node:stream/web";
import type { InferenceSession } from "onnxruntime-node";
import { dataLayout } from "../data-home.js";

const MODELS = {
  detector: {
    file: "ppocr-v5-det.onnx", size: 4826518,
    sha256: "a431985659dc921974177a95adcfbb90fd9e51989a5e04d70d0b75f597b6e61d",
    url: "https://huggingface.co/PaddlePaddle/PP-OCRv5_mobile_det_onnx/resolve/e6f4fa85f00e168c862bc462aebca69eef9b3d3d/inference.onnx",
  },
  lama: {
    file: "lama-fp32.onnx", size: 208044816,
    sha256: "1faef5301d78db7dda502fe59966957ec4b79dd64e16f03ed96913c7a4eb68d6",
    url: "https://huggingface.co/Carve/LaMa-ONNX/resolve/c3c0c9e468934d62e79c329e35d82dd09ff8c444/lama_fp32.onnx",
  },
} as const;

type ModelName = keyof typeof MODELS;

function directory(): string {
  return process.env.VIDEOBOOK_CLEANUP_MODEL_DIR?.trim() || join(dataLayout().root, "runtime", "models", "video-cleanup");
}

export async function cleanupModelStatus(): Promise<{ detector: boolean; lama: boolean; download_bytes: number }> {
  const present = async (name: ModelName) => (await stat(join(directory(), MODELS[name].file)).catch(() => null))?.size === MODELS[name].size;
  return { detector: await present("detector"), lama: await present("lama"), download_bytes: MODELS.detector.size + MODELS.lama.size };
}

async function verified(name: ModelName): Promise<boolean> {
  const model = MODELS[name];
  const path = join(directory(), model.file);
  if ((await stat(path).catch(() => null))?.size !== model.size) return false;
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex") === model.sha256;
}

export async function installCleanupModels(signal: AbortSignal): Promise<void> {
  await mkdir(directory(), { recursive: true });
  for (const name of ["detector", "lama"] as const) {
    signal.throwIfAborted();
    if (await verified(name)) continue;
    const model = MODELS[name];
    const partial = join(directory(), `${model.file}.${randomUUID()}.partial`);
    try {
      const downloadSignal = AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]);
      const response = await fetch(model.url, { signal: downloadSignal });
      if (!response.ok || !response.body) throw new Error(`Local model download failed: HTTP ${response.status}.`);
      const hash = createHash("sha256");
      let bytes = 0;
      const check = new Transform({ transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        hash.update(chunk);
        callback(bytes > model.size ? new Error("Local model download exceeded its expected size.") : null, chunk);
      } });
      await pipeline(Readable.fromWeb(response.body as ReadableStream<Uint8Array>), check, createWriteStream(partial, { flags: "wx" }), { signal: downloadSignal });
      if (bytes !== model.size || hash.digest("hex") !== model.sha256) throw new Error("Local model checksum mismatch. Retry the download.");
      signal.throwIfAborted();
      await rename(partial, join(directory(), model.file));
    } finally {
      await rm(partial, { force: true });
    }
  }
}

export async function cleanupSession(name: ModelName): Promise<InferenceSession> {
  if (!await verified(name)) throw new Error("Install the local removal models first (Download models in the remover, or remove_video_graphics op=install_models).");
  const { InferenceSession } = await import("onnxruntime-node");
  return InferenceSession.create(join(directory(), MODELS[name].file), { executionProviders: ["cpu"], intraOpNumThreads: 2, interOpNumThreads: 1 });
}
