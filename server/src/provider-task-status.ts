import type { Engine, Job } from "videobook-engine";
import { MEDIA_TASK_TYPES } from "./media/adapters/types.js";
import { parseModelId } from "./media/model-id.js";
import { legacyMediaForTaskType } from "./media/legacy-task-types.js";
import { readProviderTaskRecord } from "./provider-task-record.js";
import type { ProviderTaskStatus } from "./provider-status-link.js";

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(...values: unknown[]): string | null {
  return values.find((value): value is string => typeof value === "string" && value.length > 0) ?? null;
}

export async function readProviderTaskStatus(
  engine: Engine,
  artifactId: string | null,
  hints: { provider?: string | null; model?: string | null; taskId?: string | null } = {},
): Promise<ProviderTaskStatus | null> {
  const [saved, payloadResult, idResult] = artifactId ? await Promise.all([
    readProviderTaskRecord(engine, artifactId),
    engine.metadata.artifacts.read<unknown>(artifactId, "generation-payload"),
    engine.metadata.artifacts.read<unknown>(artifactId, "kie-task-id"),
  ]) : [null, null, null];
  const payload = payloadResult?.ok ? record(payloadResult.value) : {};
  const storedId = idResult?.ok ? record(idResult.value) : {};
  const endpoint = firstString(payload.endpoint_id, saved?.meta.falEndpointId, saved?.meta.endpointId, saved?.meta.endpoint_id);
  const catalogModelId = firstString(saved?.meta.model, hints.model) ?? "";
  const catalogModel = parseModelId(catalogModelId);
  if (catalogModelId.includes(":") && !catalogModel) return null;
  const model = firstString(endpoint, payload.model, catalogModel?.apiId, saved?.meta.apiModel, saved?.meta.model, hints.model);
  const taskId = firstString(saved?.taskId, storedId.taskId, hints.taskId);
  const machgenTask = saved?.taskType === MEDIA_TASK_TYPES.machgen;
  if (saved && /^(?:xai|alibaba)_/u.test(saved.taskType)) return null;
  if (saved && !machgenTask && saved.taskType !== "media_kie" && saved.taskType !== "isolate_vocals"
    && !saved.taskType.startsWith("fal_") && legacyMediaForTaskType(saved.taskType) === null) return null;
  const provider = endpoint || saved?.taskType.startsWith("fal_") ? "fal"
    : machgenTask ? "machgen"
      : catalogModel?.provider ?? hints.provider ?? (storedId.taskId || saved ? "kie" : null);
  if (provider !== "kie" && provider !== "fal" && provider !== "machgen") return null;
  return { provider, model, taskId: taskId === "queued" ? null : taskId };
}

export async function jobProviderTaskStatus(engine: Engine, job: Job): Promise<ProviderTaskStatus | null> {
  if (!job.type.startsWith("generate_") && job.type !== "await_notebook_output"
    && !/^complete_.*task$/u.test(job.type)) return null;
  const catalogModel = parseModelId(firstString(job.payload.model) ?? "");
  const artifactId = firstString(job.payload.providerArtifactId, job.artifactId,
    job.payload.imageAssetId, job.payload.imgAssetId, job.payload.vidAssetId, job.payload.assetId);
  return readProviderTaskStatus(engine, artifactId, {
    provider: catalogModel?.provider ?? null,
    model: firstString(job.payload.endpointId, job.payload.modelId, job.payload.model),
    taskId: firstString(record(job.result).taskId, job.payload.taskId),
  });
}
