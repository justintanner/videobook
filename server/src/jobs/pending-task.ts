import type { ClipfirstFs } from "clipfirst-fs";

export type PendingKieTask = {
  taskId: string;
  taskType: "nano_banana_image" | "grok_imagine_video" | "grok_imagine_image" | "gpt_image" | "transcribe";
  assetId: string;
  assetDir: string;
  projectSlug: string;
  createdAt: string;
  meta: Record<string, unknown>;
};

export async function writePendingTask(fs: ClipfirstFs, assetId: string, projectSlug: string, task: PendingKieTask): Promise<void> {
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

export async function findPendingTasks(fs: ClipfirstFs, projectSlug: string): Promise<PendingKieTask[]> {
  const assets = await fs.listAssets(projectSlug);
  const tasks: PendingKieTask[] = [];

  for (const asset of assets) {
    const task = await readPendingTask(fs, asset.id, projectSlug);
    if (task) tasks.push(task);
  }

  return tasks;
}
