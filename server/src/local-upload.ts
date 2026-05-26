import type { ClipfirstFs, FsError } from "vc-engine";
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
}

interface UploadLocalStreamArgs {
  projectSlug: string;
  filename: string;
  stream: Readable;
  origin?: string;
  waitForProcessing?: boolean;
}

function statusCodeForFsError(error: FsError): number {
  if (error.code === "NOT_FOUND") return 404;
  if (error.code === "INVALID_INPUT" || error.code === "ALREADY_EXISTS") return 400;
  if (error.code === "LOCKED") return 423;
  return 500;
}

export async function uploadLocalBytes(
  fs: ClipfirstFs,
  args: UploadLocalBytesArgs,
): Promise<LocalUploadOutcome> {
  return uploadLocal(fs, {
    projectSlug: args.projectSlug,
    filename: args.filename,
    origin: args.origin,
    waitForProcessing: args.waitForProcessing,
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
  fs: ClipfirstFs,
  args: UploadLocalStreamArgs,
): Promise<LocalUploadOutcome> {
  return uploadLocal(fs, {
    projectSlug: args.projectSlug,
    filename: args.filename,
    origin: args.origin,
    waitForProcessing: args.waitForProcessing,
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
  write: (assetId: string, writtenFilename: string, assetPath: string) => Promise<UploadWriteResult>;
}

// Long enough to cover slow streaming writes for large videos plus the
// runner's 250ms poll. process_video writes .original.json a few seconds in,
// so even if this lock expires mid-job, the sweep falls back to the metadata
// presence check and still skips the asset.
const UPLOAD_LOCK_MS = 5 * 60_000;

async function uploadLocal(
  fs: ClipfirstFs,
  args: UploadLocalArgs,
): Promise<LocalUploadOutcome> {
  const ext = path.extname(args.filename).toLowerCase();
  const prefix = extensionToPrefix[ext];
  if (!prefix) {
    return {
      ok: false,
      statusCode: 400,
      message: `Unsupported file extension: ${ext}`,
    };
  }

  const assetName = path.basename(args.filename, ext);
  const assetResult = await fs.createAsset(prefix, assetName, args.projectSlug);
  if (!assetResult.ok) {
    return {
      ok: false,
      statusCode: statusCodeForFsError(assetResult.error),
      message: assetResult.error.message,
    };
  }

  const { assetId, path: assetPath } = assetResult.value;
  const writtenFilename = `original${ext}`;

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
      if (assetId.startsWith("vid-")) {
        const videoPath = path.join(assetPath, writtenFilename);
        const jobId = `process-video-${assetId}-${Date.now()}`;
        const payload = {
          type: "process_video",
          videoPath,
          assetId,
          assetDir: assetPath,
          projectSlug: args.projectSlug,
          provenance,
          ...(args.waitForProcessing ? { skipDownstreamJobs: true } : {}),
        } as unknown as Record<string, unknown>;
        if (args.waitForProcessing) {
          await queue.enqueueAndWait(jobId, payload).catch(() => undefined);
        } else {
          await queue.enqueue(jobId, payload);
        }
      } else if (assetId.startsWith("img-")) {
        const jobId = `process-image-${assetId}-${Date.now()}`;
        const payload = {
          type: "process_image",
          assetId,
          projectSlug: args.projectSlug,
          extension: ext,
          provenance,
        } as unknown as Record<string, unknown>;
        if (args.waitForProcessing) {
          await queue.enqueueAndWait(jobId, payload).catch(() => undefined);
        } else {
          await queue.enqueue(jobId, payload);
        }
      } else {
        await fs.writeMetadata(assetId, "original", provenance, args.projectSlug);
      }
      outcome = {
        ok: true,
        value: { assetId, path: assetPath, filename: writtenFilename },
      };
    }
  } finally {
    // deleteAsset refuses while the lock is held, so always release before
    // any cleanup branch below runs.
    await fs.releaseLock(assetPath).catch(() => {});
  }

  if (!outcome.ok) {
    await fs.deleteAsset(assetId, args.projectSlug).catch(() => {});
  }
  return outcome;
}
