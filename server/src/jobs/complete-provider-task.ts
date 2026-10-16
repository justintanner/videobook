import type { Engine } from "videobook-engine";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeFile, unlink, readFile as readFsFile } from "node:fs/promises";
import { logger } from "../logger.js";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";
import { runFfmpeg } from "../ffmpeg.js";
import { completeMediaGeneration, providerResultUrls } from "../media/complete.js";
import { MEDIA_TASK_TYPES } from "../media/adapters/types.js";
import { legacyMediaForTaskType, legacyMediaMeta } from "../media/legacy-task-types.js";

const LOCK_DURATION_MS = 300_000;

const TASK_TYPES_BY_COMPLETION_FAMILY = {
  isolateVocals: ["isolate_vocals"],
  media: Object.values(MEDIA_TASK_TYPES),
} as const;

type ProviderCompletionFamily = keyof typeof TASK_TYPES_BY_COMPLETION_FAMILY;

const COMPLETION_FAMILY_BY_TASK_TYPE = new Map<string, ProviderCompletionFamily>(
  Object.entries(TASK_TYPES_BY_COMPLETION_FAMILY).flatMap(([family, taskTypes]) =>
    taskTypes.map((taskType) => [taskType, family as ProviderCompletionFamily]),
  ),
);

export function completionFamilyForTaskType(taskType: string): ProviderCompletionFamily | undefined {
  return COMPLETION_FAMILY_BY_TASK_TYPE.get(taskType)
    ?? (legacyMediaForTaskType(taskType) ? "media" : undefined);
}

type CompleteProviderTaskPayload = {
  type: "complete_kie_task";
  taskId: string;
  taskType: string;
  assetId: string;
  assetDir: string;
  bookId: string;
  meta: Record<string, unknown>;
  resultUrls: string[];
  resultObject?: Record<string, unknown>;
};

type ReclaimableTask = Pick<CompleteProviderTaskPayload, "assetId" | "taskId" | "taskType" | "meta">;

async function reclaimFailedCompletion(
  engine: Engine,
  task: ReclaimableTask,
  ctx: JobHandlerContext,
): Promise<string | null> {
  const { assetId, taskId, taskType, meta } = task;
  const failure = engine.jobs.failures.read(assetId);
  if (!failure.ok || !failure.value) return null;
  const pending = engine.jobs.pending.read(assetId);
  if (!pending.ok || pending.value) return null;
  const cleared = await engine.jobs.failures.clear(assetId);
  if (!cleared.ok || !cleared.value) return null;
  const lease = engine.jobs.artifactWork.begin(assetId, {
    kind: "generate",
    ownerKind: "job",
    durationMs: LOCK_DURATION_MS,
  });
  if (!lease) throw new Error(`Could not re-claim ${assetId} to retry its completion`);
  ctx.setLease({ kind: "owner", ownerId: lease.ownerId });
  const written = await engine.jobs.pending.write({ artifactId: assetId, taskId, taskType, meta }, lease.ownerId);
  if (!written.ok) {
    throw new Error(`Failed to re-register provider task ${taskId} for ${assetId}: ${written.error.message}`);
  }
  if (written.value === null) {
    throw new Error(`Lost the lease on ${assetId} while re-registering provider task ${taskId}`);
  }
  return lease.ownerId;
}

export function registerCompleteProviderTaskJob(engine: Engine): void {
  registerJobHandler("complete_kie_task", async (payload, ctx) => {
    const {
      taskId, taskType, assetId, bookId, meta,
      resultUrls, resultObject,
    } = payload as CompleteProviderTaskPayload;

    // Pattern C: inherit the provider lease via getOwner, abort if the row
    // already terminated, and register the lease so the wrapper's catch path
    // CAS-fails by task_id (unaffected by a fresh retry on the same asset).
    // A row that was failed by an earlier completion attempt is re-claimed
    // instead, so retrying the job after the cause is fixed finishes the
    // asset rather than silently skipping it.
    const ownerId = engine.jobs.pending.getOwner(assetId, taskId)
      ?? await reclaimFailedCompletion(engine, { assetId, taskId, taskType, meta }, ctx);
    if (!ownerId) {
      // The row was already removed by a delete or a stale duplicate
      // dispatch. Either way the task is no longer ours to complete.
      return { success: true, skipped: true };
    }
    ctx.setLease({ kind: "task", taskId });

    const completionFamily = completionFamilyForTaskType(taskType);
    if (!completionFamily) {
      throw new Error(`Unhandled provider task type: ${taskType}`);
    }

    // Resolve the asset directory at runtime so renames don't break completion.
    const assetDirResult = await engine.workspaces.resolveArtifact(assetId);
    if (!assetDirResult.ok) {
      await engine.jobs.pending.delete(assetId, taskId);
      return { success: true, skipped: true };
    }
    const assetDir = assetDirResult.value;

    const lockState = taskType === "isolate_vocals" ? "isolating" : "generating";
    const lockResult = await engine.jobs.locks.acquire(assetDir, { durationMs: LOCK_DURATION_MS, data: { state: lockState } });
    if (!lockResult.ok) {
      // LOCKED means another completion job for this same asset is already
      // running (sync can enqueue duplicates between polls because
      // the provider task remains pending until the completion job finishes).
      // Treat as a no-op — the other job will finish the work.
      if (lockResult.error.code === "LOCKED") {
        return { success: true, skipped: true };
      }
      throw new Error(`Asset is locked: ${lockResult.error.message}`);
    }

    // Renew the provider lease while we work — covers downloads + processing.
    const heartbeat = setInterval(() => {
      try {
        engine.jobs.artifactWork.renew(assetId, ownerId, 60_000);
      } catch (error) {
        logger.warn("heartbeat-failed", { assetId, error });
      }
    }, 20_000);

    const urls = completionFamily === "media"
      ? providerResultUrls(resultUrls, resultObject)
      : resultUrls;

    try {
      switch (completionFamily) {
        case "isolateVocals":
          await completeIsolateVocals(engine, assetId, meta, urls);
          break;
        case "media":
          await completeMediaGeneration({
            engine,
            assetId,
            assetDir,
            bookId,
            meta: legacyMediaMeta(taskType, meta),
            outputs: urls.map((url) => ({ url })),
          });
          break;
        default: {
          const unhandledFamily: never = completionFamily;
          throw new Error(`Unhandled provider completion family: ${unhandledFamily}`);
        }
      }

      await engine.jobs.pending.delete(assetId, taskId);
      return { success: true };
    } finally {
      clearInterval(heartbeat);
      await engine.jobs.locks.release(assetDir);
    }
  });
}

async function completeIsolateVocals(
  engine: Engine,
  assetId: string,
  meta: Record<string, unknown>,
  resultUrls: string[],
): Promise<void> {
  const vocalsUrl = resultUrls[0];
  if (!vocalsUrl) throw new Error("No vocals URL in result");

  const response = await fetch(vocalsUrl);
  if (!response.ok) throw new Error(`Failed to download vocals: ${response.status} ${response.statusText}`);

  let vocalsBuffer = Buffer.from(await response.arrayBuffer());

  // Trim back to original duration if audio was padded before upload
  const originalDuration = meta.originalDuration as number | undefined;
  if (originalDuration !== undefined) {
    const tmpIn = join(tmpdir(), `isolate-trim-in-${Date.now()}.mp3`);
    const tmpOut = join(tmpdir(), `isolate-trim-out-${Date.now()}.mp3`);
    try {
      await writeFile(tmpIn, vocalsBuffer);
      await runFfmpeg(["-y", "-i", tmpIn, "-t", String(originalDuration), tmpOut]);
      vocalsBuffer = await readFsFile(tmpOut);
    } finally {
      await unlink(tmpIn).catch(() => {});
      await unlink(tmpOut).catch(() => {});
    }
  }

  const isAudioAsset = meta.isAudioAsset as boolean;

  if (isAudioAsset) {
    // Audio assets: write mix.mp3 and .mix.json
    await engine.files.write(assetId, "mix.mp3", vocalsBuffer);
    const mixSettings = { volume: 100, fadeIn: 0, fadeOut: 0 };
    await engine.files.write(assetId, ".mix.json", JSON.stringify(mixSettings, null, 2));
  } else {
    // Video assets: write audio_vocals.mp3
    await engine.files.write(assetId, "audio_vocals.mp3", vocalsBuffer);

    // Optionally write background audio if a second URL exists
    if (resultUrls[1]) {
      const bgResponse = await fetch(resultUrls[1]);
      if (bgResponse.ok) {
        let bgBuffer = Buffer.from(await bgResponse.arrayBuffer());
        if (originalDuration !== undefined) {
          const tmpBgIn = join(tmpdir(), `isolate-bg-in-${Date.now()}.mp3`);
          const tmpBgOut = join(tmpdir(), `isolate-bg-out-${Date.now()}.mp3`);
          try {
            await writeFile(tmpBgIn, bgBuffer);
            await runFfmpeg(["-y", "-i", tmpBgIn, "-t", String(originalDuration), tmpBgOut]);
            bgBuffer = await readFsFile(tmpBgOut);
          } finally {
            await unlink(tmpBgIn).catch(() => {});
            await unlink(tmpBgOut).catch(() => {});
          }
        }
        await engine.files.write(assetId, "audio_background.mp3", bgBuffer);
      }
    }
  }

  await engine.history.recordOperation("isolate_vocals", assetId, { mode: "cloud" });
}
