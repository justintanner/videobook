import type { CostHints } from "@apicity/cost";
import type { Engine } from "videobook-engine";

const SEEDANCE_DRAFT_COMPLETE_MODEL = "kie:bytedance/seedance-2-5-draft";
const SEEDANCE_DRAFT_SOURCE_MODEL = "bytedance/seedance-2-5";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function seconds(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

async function readRecord(engine: Engine, artifactId: string, key: string): Promise<Record<string, unknown>> {
  const result = await engine.metadata.artifacts.read<unknown>(artifactId, key);
  return result.ok ? record(result.value) : {};
}

async function kieTaskArtifact(engine: Engine, taskId: string): Promise<string | null> {
  for (const artifact of engine.artifacts.list()) {
    if (artifact.kind !== "video") continue;
    const stored = await readRecord(engine, artifact.artifactId, "kie-task-id");
    if (stored.taskId === taskId) return artifact.artifactId;
  }
  return null;
}

function inputSeconds(input: Record<string, unknown>, hints: Record<string, unknown>): number | undefined {
  const stored = hints.inputDurationSeconds;
  if (typeof stored === "number" && Number.isFinite(stored) && stored >= 0) return stored;
  const videos = input.reference_video_urls;
  return Array.isArray(videos) && videos.length > 0 ? undefined : 0;
}

async function seedanceDraftCostHints(engine: Engine, model: string, options: Record<string, unknown>): Promise<CostHints> {
  if (model !== SEEDANCE_DRAFT_COMPLETE_MODEL) return {};
  const taskId = typeof options.draft_task_id === "string" ? options.draft_task_id.trim() : "";
  const artifactId = taskId ? await kieTaskArtifact(engine, taskId) : null;
  if (!artifactId) return {};
  const payload = await readRecord(engine, artifactId, "generation-payload");
  const input = record(payload.input);
  if (payload.model !== SEEDANCE_DRAFT_SOURCE_MODEL || input.draft !== true) return {};
  const generated = seconds((await readRecord(engine, artifactId, "original")).duration);
  const durationSeconds = seconds(input.duration) ?? (generated === undefined ? undefined : Math.round(generated));
  const inputDurationSeconds = inputSeconds(input, await readRecord(engine, artifactId, "generation-cost-hints"));
  return {
    ...(durationSeconds !== undefined ? { durationSeconds } : {}),
    ...(inputDurationSeconds !== undefined ? { inputDurationSeconds } : {}),
  };
}

const GEMINI_EXTEND_MODEL = "kie:google/gemini-omni-flash-1-2-extend";
const GEMINI_EXTEND_SOURCE = "google/gemini-omni-flash-1-2";
const GEMINI_EXTEND_RESOLUTIONS = new Set(["360p", "720p"]);

async function geminiSourceResolution(engine: Engine, artifactId: string): Promise<unknown> {
  const payload = await readRecord(engine, artifactId, "generation-payload");
  if (payload.model === GEMINI_EXTEND_SOURCE) return record(payload.input).resolution;
  if (payload.model !== GEMINI_EXTEND_MODEL.slice("kie:".length)) return undefined;
  return (await readRecord(engine, artifactId, "generation-cost-hints")).inputResolution;
}

async function geminiExtendCostHints(engine: Engine, model: string, options: Record<string, unknown>): Promise<CostHints> {
  if (model !== GEMINI_EXTEND_MODEL) return {};
  const taskId = typeof options.task_id === "string" ? options.task_id.trim() : "";
  const artifactId = taskId ? await kieTaskArtifact(engine, taskId) : null;
  if (!artifactId) return {};
  const resolution = await geminiSourceResolution(engine, artifactId);
  return typeof resolution === "string" && GEMINI_EXTEND_RESOLUTIONS.has(resolution) ? { inputResolution: resolution } : {};
}

const GEMINI_EXTEND_MAX_SECONDS = 15;
const GEMINI_EXTEND_REQUIREMENT = "Gemini Omni 1.2 Flash Extend takes only a 360p or 720p Gemini Omni 1.2 Flash video of at most 15 s that Kie generated in this book";

async function geminiSourceSeconds(engine: Engine, artifactId: string, payload: Record<string, unknown>): Promise<number | undefined> {
  const requested = payload.model === GEMINI_EXTEND_SOURCE ? seconds(record(payload.input).duration) : undefined;
  if (requested !== undefined) return requested;
  const probed = seconds((await readRecord(engine, artifactId, "original")).duration);
  return probed === undefined ? undefined : Math.round(probed);
}

async function geminiExtendSourceProblem(engine: Engine, artifactId: string): Promise<string | null> {
  const pending = engine.jobs.pending.read(artifactId);
  if (pending.ok && pending.value) return "is still generating; wait for it to finish";
  const payload = await readRecord(engine, artifactId, "generation-payload");
  const model = payload.model;
  if (typeof model === "string" && model !== GEMINI_EXTEND_SOURCE && model !== GEMINI_EXTEND_MODEL.slice("kie:".length)) {
    return `is a ${model} video`;
  }
  const resolution = await geminiSourceResolution(engine, artifactId);
  if (typeof resolution === "string" && !GEMINI_EXTEND_RESOLUTIONS.has(resolution)) return `is ${resolution}`;
  const length = await geminiSourceSeconds(engine, artifactId, payload);
  return length !== undefined && length > GEMINI_EXTEND_MAX_SECONDS ? `is ${length} s long` : null;
}

export function kieTaskSourceModel(model: string): boolean {
  return model === GEMINI_EXTEND_MODEL;
}

export async function kieTaskSourceError(engine: Engine, model: string, options: Record<string, unknown>): Promise<string | null> {
  if (model !== GEMINI_EXTEND_MODEL) return null;
  const taskId = typeof options.task_id === "string" ? options.task_id.trim() : "";
  const artifactId = taskId ? await kieTaskArtifact(engine, taskId) : null;
  const problem = artifactId ? await geminiExtendSourceProblem(engine, artifactId) : null;
  return problem ? `The video of Kie task ${taskId} ${problem}; ${GEMINI_EXTEND_REQUIREMENT}` : null;
}

export async function kieTaskSourceCostHints(engine: Engine, model: string, options: Record<string, unknown>): Promise<CostHints> {
  return { ...await seedanceDraftCostHints(engine, model, options), ...await geminiExtendCostHints(engine, model, options) };
}
