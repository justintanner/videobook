import type { Engine, PendingTask } from "videobook-engine";

interface ProviderTaskRecord {
  taskId: string;
  taskType: string;
  createdAt: number;
  meta: Record<string, unknown>;
}

function taskRecord(value: unknown): ProviderTaskRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.taskId !== "string" || !record.taskId
    || typeof record.taskType !== "string" || !record.taskType
    || typeof record.createdAt !== "number"
    || !record.meta || typeof record.meta !== "object" || Array.isArray(record.meta)
  ) return null;
  return {
    taskId: record.taskId,
    taskType: record.taskType,
    createdAt: record.createdAt,
    meta: record.meta as Record<string, unknown>,
  };
}

export async function preserveProviderTask(
  engine: Engine,
  task: PendingTask,
): Promise<void> {
  const written = await engine.metadata.artifacts.write(task.artifactId, "provider-task", {
    taskId: task.taskId,
    taskType: task.taskType,
    createdAt: task.createdAt,
    meta: task.meta,
  });
  if (!written.ok) throw new Error(written.error.message);
}

export async function readProviderTaskRecord(
  engine: Engine,
  artifactId: string,
): Promise<ProviderTaskRecord | null> {
  const pending = engine.jobs.pending.read(artifactId);
  if (pending.ok && pending.value) return pending.value;
  const saved = await engine.metadata.artifacts.read<unknown>(artifactId, "provider-task");
  const record = saved.ok ? taskRecord(saved.value) : null;
  return record;
}

export async function recoverNotebookProviderTask(
  engine: Engine,
  artifactId: string,
): Promise<boolean> {
  const pending = engine.jobs.pending.read(artifactId);
  if (!pending.ok) return false;
  if (pending.value) {
    if (pending.value.completing) {
      const active = engine.jobs.queue.list({ states: ["queued", "running", "completing"] });
      if (!active.some((job) => job.type === "complete_kie_task"
        && job.payload.assetId === artifactId
        && job.payload.taskId === pending.value?.taskId)) {
        const cleared = engine.jobs.pending.clearCompleting(artifactId);
        if (!cleared.ok) throw new Error(cleared.error.message);
      }
    }
    return true;
  }
  const failure = engine.jobs.failures.read(artifactId);
  if (!failure.ok || failure.value) return false;
  if (engine.jobs.queue.list({
    states: ["queued", "running", "completing"], artifactId,
  }).length > 0) return false;
  const status = await engine.status.get(artifactId);
  if (!status.ok || status.value === "ready") return false;
  const record = await readProviderTaskRecord(engine, artifactId);
  if (!record || record.taskId === "queued") return false;
  const owner = engine.jobs.artifactWork.begin(artifactId, {
    kind: "generate", ownerKind: "job", durationMs: 60_000,
  });
  if (!owner) return false;
  const restored = await engine.jobs.pending.write({ artifactId, ...record }, owner.ownerId);
  if (!restored.ok) throw new Error(restored.error.message);
  if (!restored.value) return false;
  await preserveProviderTask(engine, restored.value.task);
  engine.jobs.artifactWork.complete(artifactId, owner.ownerId);
  return true;
}
