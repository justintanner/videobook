import type { ClipfirstFs, FailureInfo } from "clipfirst-engine";

/**
 * Atomically transition a pending-task → generation-error and log the
 * failure to the project's action log.
 *
 * Called from sync.ts and the queue cleanup path. The engine's
 * `pendingTasks.fail()` is atomic for the SQL transition but does not
 * write to the action log; this helper composes both so callers don't
 * have to repeat the logAction boilerplate.
 */
export async function failPendingTaskAndLog(
  fs: ClipfirstFs,
  projectSlug: string,
  assetId: string,
  info: FailureInfo,
): Promise<void> {
  const result = await fs.pendingTasks.fail(projectSlug, assetId, info);
  if (!result.ok) return;
  await fs
    .logAction(
      "job-error",
      {
        assetId,
        error: info.message,
        ...(info.failCode !== undefined ? { failCode: info.failCode } : {}),
      },
      projectSlug,
    )
    .catch(() => {});
}
