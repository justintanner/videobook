import type { Engine, FailureInfo } from "videobook-engine";

/**
 * CAS-fail a pending task by (asset_id, task_id) and log to the project's
 * action log. Required everywhere that fails a provider task: the task_id
 * scopes the CAS so a late failure of an old task can't clobber a fresh
 * retry that already replaced the row.
 */
export async function failPendingTaskAndLog(
  fs: Engine,
  bookId: string,
  assetId: string,
  taskId: string,
  info: FailureInfo,
): Promise<void> {
  const result = await fs.jobs.pending.fail(assetId, taskId, info);
  if (!result.ok) return;
  await fs
    .history.logAction("job-error", {
        assetId,
        error: info.message,
        ...(info.failCode !== undefined ? { failCode: info.failCode } : {}),
      }
    )
    .catch(() => {});
}
