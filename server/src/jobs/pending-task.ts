import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import type { ClipfirstFs } from "clipfirst-fs";

export type PendingKieTask = {
  taskId: string;
  taskType: "nano_banana_image" | "grok_imagine_video" | "transcribe";
  assetId: string;
  assetDir: string;
  projectSlug: string;
  createdAt: string;
  meta: Record<string, unknown>;
};

const FILENAME = ".kie-task.json";

export async function writePendingTask(assetDir: string, task: PendingKieTask): Promise<void> {
  await writeFile(join(assetDir, FILENAME), JSON.stringify(task, null, 2));
}

export async function readPendingTask(assetDir: string): Promise<PendingKieTask | null> {
  try {
    const data = await readFile(join(assetDir, FILENAME), "utf-8");
    return JSON.parse(data) as PendingKieTask;
  } catch {
    return null;
  }
}

export async function deletePendingTask(assetDir: string): Promise<void> {
  try {
    await unlink(join(assetDir, FILENAME));
  } catch {
    // already deleted
  }
}

export async function findPendingTasks(fs: ClipfirstFs, projectSlug: string): Promise<PendingKieTask[]> {
  const assets = await fs.listAssets(projectSlug);
  const tasks: PendingKieTask[] = [];

  for (const asset of assets) {
    const task = await readPendingTask(asset.path);
    if (task) tasks.push(task);
  }

  return tasks;
}
