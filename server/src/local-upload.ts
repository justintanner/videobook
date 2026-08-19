import type { Engine, EngineError } from "videobook-engine";
import { createWriteStream } from "node:fs";
import { unlink } from "node:fs/promises";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { queue } from "./queue.js";

const extensionToKind: Record<string, string> = {
  ".mp4": "video",
  ".mov": "video",
  ".webm": "video",
  ".avi": "video",
  ".mkv": "video",
  ".jpg": "image",
  ".jpeg": "image",
  ".png": "image",
  ".gif": "image",
  ".webp": "image",
  ".svg": "image",
  ".mp3": "audio",
  ".wav": "audio",
  ".aac": "audio",
  ".flac": "audio",
  ".ogg": "audio",
  ".m4a": "audio",
  ".weba": "audio",
  ".md": "script",
};

export interface LocalUploadResult {
  artifactId: string;
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
  bookId: string;
  filename: string;
  data: Buffer;
  origin?: string;
  waitForProcessing?: boolean;
  targetAssetId?: string;
}

interface UploadLocalStreamArgs {
  bookId: string;
  filename: string;
  stream: Readable;
  origin?: string;
  waitForProcessing?: boolean;
  targetAssetId?: string;
}

function statusCodeForFsError(error: EngineError): number {
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "INVALID_INPUT" || error.code === "ALREADY_EXISTS") return 400;
  if (error.code === "LOCKED") return 423;
  return 500;
}

export async function uploadLocalBytes(
  engine: Engine,
  args: UploadLocalBytesArgs,
): Promise<LocalUploadOutcome> {
  return uploadLocal(engine, {
    bookId: args.bookId,
    filename: args.filename,
    origin: args.origin,
    waitForProcessing: args.waitForProcessing,
    targetAssetId: args.targetAssetId,
    write: async (assetId, writtenFilename) => {
      const writeResult = await engine.files.write(assetId, writtenFilename, args.data
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
  engine: Engine,
  args: UploadLocalStreamArgs,
): Promise<LocalUploadOutcome> {
  return uploadLocal(engine, {
    bookId: args.bookId,
    filename: args.filename,
    origin: args.origin,
    waitForProcessing: args.waitForProcessing,
    targetAssetId: args.targetAssetId,
    write: async (assetId, writtenFilename, assetPath) => {
      const filePath = path.join(assetPath, writtenFilename);
      try {
        await pipeline(args.stream, createWriteStream(filePath, { flags: "wx" }));
        const ingested = await engine.files.ingestWorkspace(
          assetId,
          [writtenFilename],
          "upload_stream",
          { file: writtenFilename },
        );
        if (!ingested.ok) throw new Error(ingested.error.message);
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
  bookId: string;
  filename: string;
  origin?: string;
  waitForProcessing?: boolean;
  targetAssetId?: string;
  write: (assetId: string, writtenFilename: string, assetPath: string) => Promise<UploadWriteResult>;
}

// Long enough to cover slow streaming writes for large videos plus the
// runner's 250ms poll. process_video writes native metadata a few seconds in,
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
  engine: Engine,
  args: UploadLocalArgs,
): Promise<LocalUploadOutcome> {
  const ext = path.extname(args.filename).toLowerCase();
  const kind = extensionToKind[ext];
  if (!kind && !args.targetAssetId) {
    return {
      ok: false,
      statusCode: 400,
      message: `Unsupported file extension: ${ext}`,
    };
  }

  let assetId: string;
  let artifactId: string;
  let assetPath: string;
  let assetKind: string;
  let isNewAsset = false;

  if (args.targetAssetId) {
    const artifact = engine.artifacts.get(args.targetAssetId);
    if (!artifact.ok) {
      return {
        ok: false,
        statusCode: statusCodeForFsError(artifact.error),
        message: artifact.error.message,
      };
    }
    if (artifact.value.kind !== "character") {
      return { ok: false, statusCode: 400, message: "Target asset must be a character folder" };
    }
    const resolveResult = await engine.workspaces.resolveArtifact(args.targetAssetId);
    if (!resolveResult.ok) {
      return { ok: false, statusCode: statusCodeForFsError(resolveResult.error), message: resolveResult.error.message };
    }
    assetId = args.targetAssetId;
    assetPath = resolveResult.value;
    artifactId = artifact.value.artifactId;
    assetKind = artifact.value.kind;
  } else {
    const assetName = path.basename(args.filename, ext);
    const assetResult = await engine.artifacts.create(kind!, assetName);
    if (!assetResult.ok) {
      return {
        ok: false,
        statusCode: statusCodeForFsError(assetResult.error),
        message: assetResult.error.message,
      };
    }
    assetId = assetResult.value.artifactId;
    artifactId = assetResult.value.artifactId;
    assetPath = assetResult.value.path;
    assetKind = assetResult.value.kind;
    isNewAsset = true;
  }

  let writtenFilename = isNewAsset ? `original${ext}` : args.filename;
  if (!isNewAsset) {
    const baseName = path.basename(args.filename, ext);
    let counter = 1;
    while (true) {
      const checkResult = await engine.files.manifest(assetId);
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
  const lockResult = await engine.jobs.locks.acquire(assetPath, {
    durationMs: UPLOAD_LOCK_MS,
    data: { state: "uploading" },
  });
  if (!lockResult.ok) {
    await engine.artifacts.delete(assetId).catch(() => {});
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
      if (assetKind === "video") {
        const videoPath = path.join(assetPath, writtenFilename);
        const jobId = `process-video-${assetId}-${Date.now()}`;
        // Downstream speech-to-text stays enqueued even when the caller waits:
        // it is fire-and-forget (separate job id), so enqueueAndWait still
        // returns as soon as processing finishes. Skipping it here left MCP
        // upload_file videos permanently transcript-less, which wedged the
        // slot auto-render pipeline for audio videos (hasAudio + no
        // .analysis.gpt4otrans.json blocks findEligibleRenderActions forever).
        // Tests stay deterministic via process-video's NODE_ENV gate.
        const payload = {
          type: "process_video",
          videoPath,
          assetId,
          assetDir: assetPath,
          bookId: args.bookId,
          provenance,
        } as unknown as Record<string, unknown>;
        processingError = await runProcessingJob(jobId, payload, args.waitForProcessing);
      } else if (assetKind === "image") {
        const jobId = `process-image-${assetId}-${Date.now()}`;
        const payload = {
          type: "process_image",
          assetId,
          bookId: args.bookId,
          extension: ext,
          provenance,
        } as unknown as Record<string, unknown>;
        processingError = await runProcessingJob(jobId, payload, args.waitForProcessing);
      } else if (assetKind === "audio") {
        const audioPath = path.join(assetPath, writtenFilename);
        const jobId = `process-audio-${assetId}-${Date.now()}`;
        const payload = {
          type: "process_audio",
          audioPath,
          sourceFilename: writtenFilename,
          assetId,
          assetDir: assetPath,
          bookId: args.bookId,
          provenance,
        } as unknown as Record<string, unknown>;
        processingError = await runProcessingJob(jobId, payload, args.waitForProcessing);
      } else {
        await engine.metadata.artifacts.write(assetId, "original", provenance);
      }
      outcome = {
        ok: true,
        value: {
          artifactId,
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
    engine.jobs.locks.release(assetPath);
  }

  if (!outcome.ok && isNewAsset) {
    await engine.artifacts.delete(assetId).catch(() => {});
  }
  return outcome;
}
