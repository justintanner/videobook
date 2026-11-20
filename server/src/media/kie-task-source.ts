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

export async function kieTaskSourceCostHints(engine: Engine, model: string, options: Record<string, unknown>): Promise<CostHints> {
  return { ...await seedanceDraftCostHints(engine, model, options), ...await geminiExtendCostHints(engine, model, options) };
}
