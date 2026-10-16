import type { SubmitContext } from "./types.js";

export async function writePendingTask(
  context: SubmitContext,
  taskId: string,
  taskType: string,
  extraMeta: Record<string, unknown> = {},
  ownerId: string = context.ctx.getOwnerId(),
): Promise<void> {
  const written = await context.engine.jobs.pending.write({
    taskId,
    taskType,
    artifactId: context.assetId,
    meta: { ...context.meta, ...extraMeta },
  }, ownerId);
  if (!written.ok) throw new Error(`Failed to write pending-task for ${context.assetId}: ${written.error.message}`);
  if (written.value === null) throw new Error(`Lost local lease for ${context.assetId} while writing pending-task`);
  context.ctx.setLease({ kind: "task", taskId });
}

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

export function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}
