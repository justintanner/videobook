import type { ClipfirstFs, AssetEntry } from "clipfirst-fs";

/** Sentinel taskId written by tool handlers before the real task is created. */
export const QUEUED_TASK_ID = "queued";

export type PendingKieTask = {
  taskId: string;
  taskType: "nano_banana_image" | "qwen2_image_edit" | "grok_imagine_video" | "grok_imagine_image" | "grok_imagine_text" | "gpt_image" | "kling30_video" | "seedance2_video" | "wan27_image" | "wan27_image_pro" | "wan27_i2v_video" | "wan27_videoedit_video" | "wan27_r2v_video" | "transcribe" | "isolate_vocals" | "xai_grok_imagine_video" | "xai_grok_imagine_ref_video" | "xai_grok_imagine_extend_video" | "grok_imagine_extend_video";
  assetId: string;
  assetDir: string;
  projectSlug: string;
  createdAt: string;
  meta: Record<string, unknown>;
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

export type FailureInfo = {
  message: string;
  failCode?: string;
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
): Promise<Array<{ assetId: string; failMsg: string; failedAt: string }>> {
  const results = await Promise.all(
    assets.map(async (asset) => {
      const result = await fs.readMetadata<{ message: string; failedAt?: string }>(asset.id, "generation-error", projectSlug);
      if (!result.ok) return null;
      return { assetId: asset.id, failMsg: result.value.message, failedAt: result.value.failedAt ?? new Date().toISOString() };
    })
  );
  return results.filter((r): r is { assetId: string; failMsg: string; failedAt: string } => r !== null);
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
