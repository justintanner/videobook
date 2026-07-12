import type { VideocityFs, FsError } from "videocity-engine";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { queue } from "./queue.js";

const extensionToPrefix: Record<string, string> = {
  ".mp4": "vid",
  ".mov": "vid",
  ".webm": "vid",
  ".avi": "vid",
  ".mkv": "vid",
  ".jpg": "img",
  ".jpeg": "img",
  ".png": "img",
  ".gif": "img",
  ".webp": "img",
  ".svg": "img",
  ".mp3": "aud",
  ".wav": "aud",
  ".aac": "aud",
  ".flac": "aud",
  ".ogg": "aud",
  ".md": "script",
};

export interface LocalUploadResult {
  assetId: string;
  path: string;
  filename: string;
  // Set when waitForProcessing was requested and the processing job failed.
  // The upload itself succeeded and the asset is kept.
  processingError?: string;
}

export type LocalUploadOutcome =
  | { ok: true; value: LocalUploadResult }
  | { ok: false; statusCode: number; message: string };

interface UploadLocalBytesArgs {
  projectSlug: string;
  filename: string;
  data: Buffer;
  origin?: string;
  waitForProcessing?: boolean;
  targetAssetId?: string;
}

interface UploadLocalStreamArgs {
  projectSlug: string;
  filename: string;
  stream: Readable;
  origin?: string;
  waitForProcessing?: boolean;
  targetAssetId?: string;
}

function statusCodeForFsError(error: FsError): number {
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "INVALID_INPUT" || error.code === "ALREADY_EXISTS") return 400;
  if (error.code === "LOCKED") return 423;
  return 500;
}

export async function uploadLocalBytes(
  fs: VideocityFs,
  args: UploadLocalBytesArgs,
): Promise<LocalUploadOutcome> {
  return uploadLocal(fs, {
    projectSlug: args.projectSlug,
    filename: args.filename,
    origin: args.origin,
    waitForProcessing: args.waitForProcessing,
    targetAssetId: args.targetAssetId,
    write: async (assetId, writtenFilename) => {
      const writeResult = await fs.writeFile(
        assetId,
        writtenFilename,
        args.data,
        args.projectSlug,
      );
      if (!writeResult.ok) {
        return {
          ok: false,
          statusCode: statusCodeForFsError(writeResult.error),
          message: writeResult.error.message,
        };
      }
      return { ok: true };
    },
  });
}

export async function uploadLocalStream(
  fs: VideocityFs,
  args: UploadLocalStreamArgs,
): Promise<LocalUploadOutcome> {
  return uploadLocal(fs, {
    projectSlug: args.projectSlug,
    filename: args.filename,
    origin: args.origin,
    waitForProcessing: args.waitForProcessing,
    targetAssetId: args.targetAssetId,
    write: async (assetId, writtenFilename, assetPath) => {
      const filePath = path.join(assetPath, writtenFilename);
      try {
        await pipeline(args.stream, createWriteStream(filePath, { flags: "wx" }));
        await fs.commitOperation("write", assetId, { file: writtenFilename }, args.projectSlug);
        return { ok: true };
      } catch (error) {
        await unlink(filePath).catch(() => {});
        return {
          ok: false,
          statusCode: 500,
          message: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

type UploadWriteResult =
  | { ok: true }
  | { ok: false; statusCode: number; message: string };

interface UploadLocalArgs {
  projectSlug: string;
  filename: string;
  origin?: string;
  waitForProcessing?: boolean;
  targetAssetId?: string;
  write: (assetId: string, writtenFilename: string, assetPath: string) => Promise<UploadWriteResult>;
}

// Long enough to cover slow streaming writes for large videos plus the
// runner's 250ms poll. process_video writes .original.json a few seconds in,
// so even if this lock expires mid-job, the sweep falls back to the metadata
// presence check and still skips the asset.
const UPLOAD_LOCK_MS = 5 * 60_000;

async function runProcessingJob(
  jobId: string,
  payload: Record<string, unknown>,
  waitForProcessing: boolean | undefined,
): Promise<string | null> {
  if (!waitForProcessing) {
    await queue.enqueue(jobId, payload);
    return null;
  }
  try {
    await queue.enqueueAndWait(jobId, payload);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

async function uploadLocal(
  fs: VideocityFs,
  args: UploadLocalArgs,
): Promise<LocalUploadOutcome> {
  const ext = path.extname(args.filename).toLowerCase();
  const prefix = extensionToPrefix[ext];
  if (!prefix && !args.targetAssetId) {
    return {
      ok: false,
      statusCode: 400,
      message: `Unsupported file extension: ${ext}`,
    };
  }

  let assetId: string;
  let assetPath: string;
  let isNewAsset = false;

  if (args.targetAssetId) {
    if (!args.targetAssetId.startsWith("char-")) {
      return { ok: false, statusCode: 400, message: "Target asset must be a character folder" };
    }
    const resolveResult = await fs.resolveAssetDir(args.targetAssetId, args.projectSlug);
    if (!resolveResult.ok) {
      return { ok: false, statusCode: statusCodeForFsError(resolveResult.error), message: resolveResult.error.message };
    }
    assetId = args.targetAssetId;
    assetPath = resolveResult.value;
  } else {
    const assetName = path.basename(args.filename, ext);
    const assetResult = await fs.createAsset(prefix!, assetName, args.projectSlug);
    if (!assetResult.ok) {
      return {
        ok: false,
        statusCode: statusCodeForFsError(assetResult.error),
        message: assetResult.error.message,
      };
    }
    assetId = assetResult.value.assetId;
    assetPath = assetResult.value.path;
    isNewAsset = true;
  }

  let writtenFilename = isNewAsset ? `original${ext}` : args.filename;
  if (!isNewAsset) {
    const baseName = path.basename(args.filename, ext);
    let counter = 1;
    while (true) {
      const checkResult = await fs.getManifest(assetId, args.projectSlug);
      if (!checkResult.ok) break;
      const exists = checkResult.value.files.some((f) => f.name === writtenFilename);
      if (!exists) break;
      writtenFilename = `${baseName}-${counter}${ext}`;
      counter++;
    }
  }

  // Hold an fs lock from before the bytes hit disk through the process_*
  // enqueue. Without it, sync's findUnprocessedUploads sweep races the
  // streaming write — sees `original.{ext}` with no metadata and no lock —
  // and queues a duplicate process_video that re-extracts every frame after
  // the real job finishes.
  const lockResult = await fs.acquireLock(assetPath, {
    durationMs: UPLOAD_LOCK_MS,
    data: { state: "uploading" },
  });
  if (!lockResult.ok) {
    await fs.deleteAsset(assetId, args.projectSlug).catch(() => {});
    return {
      ok: false,
      statusCode: statusCodeForFsError(lockResult.error),
      message: lockResult.error.message,
    };
  }

  let outcome: LocalUploadOutcome;
  try {
    const writeResult = await args.write(assetId, writtenFilename, assetPath);
    if (!writeResult.ok) {
      outcome = {
        ok: false,
        statusCode: writeResult.statusCode,
        message: writeResult.message,
      };
    } else {
      const provenance = { origin: args.origin ?? "upload", processed_at: new Date().toISOString() };
      let processingError: string | null = null;
      if (assetId.startsWith("vid-")) {
        const videoPath = path.join(assetPath, writtenFilename);
        const jobId = `process-video-${assetId}-${Date.now()}`;
        // Downstream speech-to-text stays enqueued even when the caller waits:
        // it is fire-and-forget (separate job id), so enqueueAndWait still
        // returns as soon as processing finishes. Skipping it here left MCP
        // upload_file videos permanently transcript-less, which wedged the
        // slot auto-render pipeline for audio videos (hasAudio + no
        // .analysis.gpt4otrans.json blocks findAutoRenderActions forever).
        // Tests stay deterministic via process-video's NODE_ENV gate.
        const payload = {
          type: "process_video",
          videoPath,
          assetId,
          assetDir: assetPath,
          projectSlug: args.projectSlug,
          provenance,
        } as unknown as Record<string, unknown>;
        processingError = await runProcessingJob(jobId, payload, args.waitForProcessing);
      } else if (assetId.startsWith("img-")) {
        const jobId = `process-image-${assetId}-${Date.now()}`;
        const payload = {
          type: "process_image",
          assetId,
          projectSlug: args.projectSlug,
          extension: ext,
          provenance,
        } as unknown as Record<string, unknown>;
        processingError = await runProcessingJob(jobId, payload, args.waitForProcessing);
      } else {
        await fs.writeMetadata(assetId, "original", provenance, args.projectSlug);
      }
      outcome = {
        ok: true,
        value: {
          assetId,
          path: assetPath,
          filename: writtenFilename,
          ...(processingError ? { processingError } : {}),
        },
      };
    }
  } finally {
    // deleteAsset refuses while the lock is held, so always release before
    // any cleanup branch below runs.
    await fs.releaseLock(assetPath).catch(() => {});
  }

  if (!outcome.ok && isNewAsset) {
    await fs.deleteAsset(assetId, args.projectSlug).catch(() => {});
  }
  return outcome;
}
