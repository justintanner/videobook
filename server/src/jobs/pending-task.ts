import type { ClipfirstFs, AssetEntry } from "clipfirst-fs";

/** Sentinel taskId written by tool handlers before the real task is created. */
export const QUEUED_TASK_ID = "queued";

export type PendingKieTask = {
  taskId: string;
  taskType: "nano_banana_image" | "qwen2_image_edit" | "seedream_text_image" | "seedream_image" | "grok_imagine_video" | "grok_imagine_image" | "grok_imagine_text" | "gpt_image" | "gpt_image_text" | "kling30_video" | "seedance2_video" | "wan27_image" | "wan27_image_pro" | "wan27_i2v_video" | "wan27_videoedit_video" | "wan27_r2v_video" | "wan27_extend_video" | "transcribe" | "fal_transcribe" | "isolate_vocals" | "xai_grok_imagine_video" | "xai_grok_imagine_ref_video" | "grok_imagine_extend_video" | "alibaba_image" | "alibaba_image_pro" | "alibaba_video" | "alibaba_qwen_image" | "alibaba_qwen_image_edit" | "fal_seedance2_i2v" | "fal_seedance2_t2v" | "fal_seedance2_r2v" | "fal_seedance2_fast_t2v" | "fal_seedance2_fast_i2v" | "fal_seedance2_fast_r2v" | "fal_nano_banana_pro" | "fal_nano_banana_pro_edit" | "fal_nano_banana" | "fal_nano_banana_edit" | "fal_nano_banana_2" | "fal_nano_banana_2_edit" | "fal_qwen_image" | "fal_qwen_image_edit" | "fal_seedream_v5_lite" | "fal_seedream_v5_lite_edit" | "fal_wan27" | "fal_wan27_edit" | "fal_wan27_pro" | "fal_wan27_pro_edit" | "fal_wan27_t2v" | "fal_wan27_i2v" | "fal_wan27_r2v" | "fal_wan27_videoedit" | "fal_grok_imagine_image" | "fal_grok_imagine_image_edit" | "fal_kling_v3_pro_i2v" | "fal_kling_v3_pro_t2v" | "fal_kling_v3_standard_t2v" | "fal_kling_v3_standard_i2v" | "fal_grok_imagine_video_i2v" | "fal_grok_imagine_video_r2v" | "fal_grok_imagine_video_extend" | "fal_grok_imagine_video_edit" | "describe_image";
  assetId: string;
  assetDir: string;
  projectSlug: string;
  createdAt: string;
  meta: Record<string, unknown>;
  /** Set when sync has enqueued a complete_kie_task job for this task.
   *  Subsequent sync polls skip this task so duplicate completion jobs
   *  don't race on the asset-directory lock. */
  completing?: boolean;
};

export async function writePendingTask(fs: ClipfirstFs, assetId: string, projectSlug: string, task: PendingKieTask): Promise<void> {
  // Clear any previous generation error so a retry doesn't show a stale failure
  await fs.deleteFile(assetId, ".generation-error.json", projectSlug).catch(() => {});
  await fs.writeMetadata(assetId, "kie-task", task, projectSlug);
}

export async function readPendingTask(fs: ClipfirstFs, assetId: string, projectSlug: string): Promise<PendingKieTask | null> {
  const result = await fs.readMetadata<PendingKieTask>(assetId, "kie-task", projectSlug);
  if (!result.ok) return null;
  return result.value;
}

export async function deletePendingTask(fs: ClipfirstFs, assetId: string, projectSlug: string): Promise<void> {
  await fs.deleteFile(assetId, ".kie-task.json", projectSlug).catch(() => {});
}

/** Stamp a pending task as "completing" so later sync polls skip it. */
export async function markTaskCompleting(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  task: PendingKieTask,
): Promise<void> {
  await fs.writeMetadata(assetId, "kie-task", { ...task, completing: true }, projectSlug);
}

export type FailureInfo = {
  message: string;
  failCode?: string;
  prompt?: string | null;
};

/**
 * Persist a generation failure to disk and clear the pending task.
 *
 * Writes `.generation-error.json` first, then deletes `.kie-task.json`. The
 * order matters: if the metadata write fails the pending task is preserved so
 * the next sync/poll can retry instead of silently dropping the task.
 */
export async function failPendingTask(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  info: FailureInfo,
): Promise<void> {
  await fs.writeMetadata(
    assetId,
    "generation-error",
    {
      message: info.message,
      ...(info.failCode !== undefined ? { failCode: info.failCode } : {}),
      ...(info.prompt != null ? { prompt: info.prompt } : {}),
      failedAt: new Date().toISOString(),
    },
    projectSlug,
  ).catch(() => {});
  await deletePendingTask(fs, assetId, projectSlug);
  await fs.logAction(
    "job-error",
    {
      assetId,
      error: info.message,
      ...(info.failCode !== undefined ? { failCode: info.failCode } : {}),
    },
    projectSlug,
  ).catch(() => {});
}

export async function findFailedAssets(
  fs: ClipfirstFs, projectSlug: string, assets: AssetEntry[],
): Promise<Array<{ assetId: string; failMsg: string; failedAt: string; prompt: string | null }>> {
  const results = await Promise.all(
    assets.map(async (asset) => {
      const result = await fs.readMetadata<{ message: string; failedAt?: string; prompt?: string }>(asset.id, "generation-error", projectSlug);
      if (!result.ok) return null;
      return {
        assetId: asset.id,
        failMsg: result.value.message,
        failedAt: result.value.failedAt ?? new Date().toISOString(),
        prompt: typeof result.value.prompt === "string" ? result.value.prompt : null,
      };
    })
  );
  return results.filter((r): r is { assetId: string; failMsg: string; failedAt: string; prompt: string | null } => r !== null);
}

export async function findPendingTasks(fs: ClipfirstFs, projectSlug: string, assets: AssetEntry[]): Promise<PendingKieTask[]> {
  const results = await Promise.all(
    assets.map((asset) => readPendingTask(fs, asset.id, projectSlug))
  );
  return results.filter((t): t is PendingKieTask => t !== null);
}

export async function cleanOrphanedQueuedTasks(fs: ClipfirstFs): Promise<number> {
  const projects = await fs.listProjects();
  let cleanedCount = 0;

  for (const project of projects) {
    const assets = await fs.listAssets(project.slug);
    const pendingTasks = await findPendingTasks(fs, project.slug, assets);
    const orphanedTasks = pendingTasks.filter((task) => task.taskId === QUEUED_TASK_ID);

    for (const task of orphanedTasks) {
      await deletePendingTask(fs, task.assetId, task.projectSlug);
      console.log(`[startup] cleaned orphaned queued task: ${task.assetId} in project ${task.projectSlug}`);
      cleanedCount++;
    }
  }

  return cleanedCount;
}

/**
 * On startup, any pending task still stamped `completing: true` belongs to
 * a completion job that did not survive the restart. Clear the flag so the
 * next sync poll re-detects success and re-enqueues the completion job.
 */
export async function resetStaleCompletingTasks(fs: ClipfirstFs): Promise<number> {
  const projects = await fs.listProjects();
  let resetCount = 0;

  for (const project of projects) {
    const assets = await fs.listAssets(project.slug);
    const pendingTasks = await findPendingTasks(fs, project.slug, assets);
    const stale = pendingTasks.filter((t) => t.completing === true);

    for (const task of stale) {
      const { completing: _dropped, ...rest } = task;
      void _dropped;
      await fs.writeMetadata(task.assetId, "kie-task", rest, task.projectSlug);
      console.log(`[startup] reset stale completing flag: ${task.assetId} in project ${task.projectSlug}`);
      resetCount++;
    }
  }

  return resetCount;
}

/**
 * Sweep `.generation-error.json` files whose message is the spurious
 * "Asset is locked: Lock already held" race artifact from duplicate
 * completion-job dispatch. These assets completed successfully; only the
 * stale error file remains and makes the tile show as failed in /inbox.
 */
export async function cleanStaleLockRaceErrors(fs: ClipfirstFs): Promise<number> {
  const LOCK_RACE_MARKER = "Lock already held";
  const projects = await fs.listProjects();
  let cleanedCount = 0;

  for (const project of projects) {
    const assets = await fs.listAssets(project.slug);
    const failures = await findFailedAssets(fs, project.slug, assets);
    for (const failure of failures) {
      if (!failure.failMsg.includes(LOCK_RACE_MARKER)) continue;
      await fs.deleteFile(failure.assetId, ".generation-error.json", project.slug).catch(() => {});
      console.log(`[startup] cleared stale lock-race error: ${failure.assetId} in project ${project.slug}`);
      cleanedCount++;
    }
  }

  return cleanedCount;
}
