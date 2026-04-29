/**
 * Thin shim over `clipfirst-fs`'s sqlite-backed `pendingTasks` /
 * `generationErrors` API. Pending-task lifecycle moved into the engine in the
 * Phase-1 refactor; this file preserves the legacy `(fs, assetId, projectSlug,
 * task)` call shape so the ~80 existing call sites can migrate gradually.
 *
 * Translations performed here:
 *  - Legacy `PendingKieTask.createdAt` is an ISO string; the engine stores
 *    epoch seconds. Shim converts in both directions.
 *  - Legacy `failPendingTask` also wrote a "job-error" action to the action
 *    log; the engine's atomic `fail()` does not, so the shim logs after the tx.
 *  - Legacy `findPendingTasks` / `findFailedAssets` accepted an `assets` array
 *    and walked sidecars per-asset; the engine version returns every row in
 *    one query, so the `assets` argument is now ignored (kept for compat).
 */

import type { ClipfirstFs, AssetEntry, PendingTask, TaskType } from "clipfirst-fs";
import { QUEUED_TASK_ID as ENGINE_QUEUED_TASK_ID } from "clipfirst-fs";

export const QUEUED_TASK_ID = ENGINE_QUEUED_TASK_ID;

export type PendingKieTask = {
  taskId: string;
  taskType: TaskType;
  assetId: string;
  assetDir: string;
  projectSlug: string;
  createdAt: string;
  meta: Record<string, unknown>;
  completing?: boolean;
};

export type FailureInfo = {
  message: string;
  failCode?: string;
  prompt?: string | null;
};

function epochToIso(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString();
}

function pendingTaskToLegacy(
  task: PendingTask,
  projectSlug: string,
): PendingKieTask {
  return {
    taskId: task.taskId,
    taskType: task.taskType,
    assetId: task.assetId,
    assetDir: task.assetDir,
    projectSlug,
    createdAt: epochToIso(task.createdAt),
    meta: task.meta,
    completing: task.completing,
  };
}

export async function writePendingTask(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  task: PendingKieTask,
): Promise<void> {
  const result = await fs.pendingTasks.write(projectSlug, {
    assetId,
    taskId: task.taskId,
    taskType: task.taskType,
    assetDir: task.assetDir,
    meta: task.meta,
    ...(task.completing !== undefined ? { completing: task.completing } : {}),
  });
  if (!result.ok) {
    throw new Error(
      `Failed to write pending-task for ${assetId}: ${result.error.message}`,
    );
  }
}

export async function readPendingTask(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
): Promise<PendingKieTask | null> {
  const result = await fs.pendingTasks.read(projectSlug, assetId);
  if (!result.ok) return null;
  return result.value ? pendingTaskToLegacy(result.value, projectSlug) : null;
}

export async function deletePendingTask(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
): Promise<void> {
  await fs.pendingTasks.delete(projectSlug, assetId);
}

export async function markTaskCompleting(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
  // task is unused now (flag flips by asset_id) but every caller passes the
  // task they just read; preserve the signature so they don't all need edits.
  _task?: PendingKieTask,
): Promise<void> {
  void _task;
  await fs.pendingTasks.markCompleting(projectSlug, assetId);
}

export async function failPendingTask(
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
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

export async function findPendingTasks(
  fs: ClipfirstFs,
  projectSlug: string,
  // Kept for compat; no longer needed since the query returns all rows.
  _assets?: AssetEntry[],
): Promise<PendingKieTask[]> {
  void _assets;
  const result = await fs.pendingTasks.findAll(projectSlug);
  if (!result.ok) return [];
  return result.value.map((t) => pendingTaskToLegacy(t, projectSlug));
}

export async function findFailedAssets(
  fs: ClipfirstFs,
  projectSlug: string,
  _assets?: AssetEntry[],
): Promise<
  Array<{
    assetId: string;
    failMsg: string;
    failedAt: string;
    prompt: string | null;
  }>
> {
  void _assets;
  const result = await fs.generationErrors.findAll(projectSlug);
  if (!result.ok) return [];
  return result.value.map((e) => ({
    assetId: e.assetId,
    failMsg: e.message,
    failedAt: epochToIso(e.failedAt),
    prompt: e.prompt ?? null,
  }));
}

export async function cleanOrphanedQueuedTasks(
  fs: ClipfirstFs,
): Promise<number> {
  const projects = await fs.listProjects();
  let cleaned = 0;
  for (const project of projects) {
    const all = await fs.pendingTasks.findAll(project.slug);
    if (!all.ok) continue;
    for (const task of all.value) {
      if (task.taskId !== QUEUED_TASK_ID) continue;
      await fs.pendingTasks.delete(project.slug, task.assetId);
      console.log(
        `[startup] cleaned orphaned queued task: ${task.assetId} in project ${project.slug}`,
      );
      cleaned++;
    }
  }
  return cleaned;
}

export async function resetStaleCompletingTasks(
  fs: ClipfirstFs,
): Promise<number> {
  const projects = await fs.listProjects();
  let reset = 0;
  for (const project of projects) {
    const all = await fs.pendingTasks.findAll(project.slug);
    if (!all.ok) continue;
    for (const task of all.value) {
      if (!task.completing) continue;
      await fs.pendingTasks.clearCompleting(project.slug, task.assetId);
      console.log(
        `[startup] reset stale completing flag: ${task.assetId} in project ${project.slug}`,
      );
      reset++;
    }
  }
  return reset;
}

export async function cleanStaleLockRaceErrors(
  fs: ClipfirstFs,
): Promise<number> {
  const LOCK_RACE_MARKER = "Lock already held";
  const projects = await fs.listProjects();
  let cleaned = 0;
  for (const project of projects) {
    const all = await fs.generationErrors.findAll(project.slug);
    if (!all.ok) continue;
    for (const e of all.value) {
      if (!e.message.includes(LOCK_RACE_MARKER)) continue;
      await fs.generationErrors.clear(project.slug, e.assetId);
      console.log(
        `[startup] cleared stale lock-race error: ${e.assetId} in project ${project.slug}`,
      );
      cleaned++;
    }
  }
  return cleaned;
}
