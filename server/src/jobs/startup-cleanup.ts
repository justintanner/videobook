import type { ClipfirstFs } from "clipfirst-engine";
import { QUEUED_TASK_ID } from "clipfirst-engine";

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
