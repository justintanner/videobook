import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { VideocityFs } from "videocity-engine";
import { z } from "zod";

// Mirrors src/components/center-stage/notebook/types.ts.
interface PlanStep {
  id: string;
  componentType: "task";
  type: "prompt" | "image" | "video";
  name: string;
  properties: Record<string, unknown>;
}

interface PlanDefinition {
  properties: Record<string, unknown>;
  sequence: PlanStep[];
}

interface NotebookPlanSidecar {
  format: "notebook";
  schema_version: 1;
  definition: PlanDefinition;
}

const planStepSchema = z.object({
  id: z.string(),
  componentType: z.literal("task"),
  type: z.enum(["prompt", "image", "video"]),
  name: z.string(),
  properties: z.record(z.string(), z.unknown()),
}).strict();

const planDefinitionSchema = z.object({
  properties: z.record(z.string(), z.unknown()),
  sequence: z.array(planStepSchema),
}).strict().superRefine((definition, context) => {
  const seen = new Set<string>();
  definition.sequence.forEach((step, index) => {
    if (seen.has(step.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate step id: ${step.id}`,
        path: ["sequence", index, "id"],
      });
      return;
    }
    seen.add(step.id);
  });
});

function emptyPlanDefinition(): PlanDefinition {
  return { properties: {}, sequence: [] };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNotebookSidecar(value: unknown): value is NotebookPlanSidecar {
  return isRecord(value) && value.format === "notebook";
}

function stringProperty(properties: Record<string, unknown>, key: string): string | null {
  const value = properties[key];
  return typeof value === "string" ? value : null;
}

function stringArrayProperty(properties: Record<string, unknown>, key: string): string[] {
  const value = properties[key];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function valuesProperty(properties: Record<string, unknown>): Record<string, unknown> {
  const value = properties.values;
  return isRecord(value) ? value : {};
}

function formatAssetRef(value: string): string {
  return value.startsWith("@") ? value : `@${value}`;
}

function renderPromptMarkdown(step: PlanStep): string[] {
  const text = stringProperty(step.properties, "text");
  return text ? [`> ${text}`] : [];
}

function renderGenerationMarkdown(step: PlanStep): string[] {
  const values = valuesProperty(step.properties);
  const refs = [
    ...stringArrayProperty(values, "image_slugs"),
    ...[stringProperty(values, "first_frame_slug"), stringProperty(values, "video_slug")]
      .filter((value): value is string => value !== null),
  ];
  const assetIds = stringArrayProperty(step.properties, "asset_ids");
  const model = stringProperty(step.properties, "model") ?? "—";
  const prompt = stringProperty(values, "prompt");

  return [
    `- **Model:** ${model}`,
    `- **Refs:** ${refs.length > 0 ? refs.join(", ") : "—"}`,
    `- **Produces:** ${assetIds.length > 0 ? assetIds.map(formatAssetRef).join(", ") : "—"}`,
    ...(prompt ? ["", `> ${prompt}`] : []),
  ];
}

function renderPlanMarkdown(definition: PlanDefinition): string {
  if (definition.sequence.length === 0) {
    return ["# Plan", "", "0 steps", "", "_No steps yet._", ""].join("\n");
  }

  return [
    "# Plan",
    "",
    `${definition.sequence.length} steps`,
    "",
    ...definition.sequence.flatMap((step, index) => [
      `## ${index + 1}. ${step.name} — ${step.type}`,
      "",
      ...(step.type === "prompt" ? renderPromptMarkdown(step) : renderGenerationMarkdown(step)),
      "",
    ]),
  ].join("\n");
}

// Write one plan file only when its content actually changed. The engine commits
// each write scoped to that file's path, and a scoped `git commit -- <path>` with
// no diff exits non-zero (empty stderr, "nothing to commit") whenever the repo is
// otherwise dirty — which it almost always is, since the engine's state DB is
// modified by routine asset work. Skipping no-op writes lets idempotent plan
// edits (e.g. "set joke" with unchanged text before generating a voiceover)
// succeed instead of throwing a bare "Failed to commit file write".
async function writePlanFileIfChanged(
  fs: VideocityFs,
  projectSlug: string,
  fileName: string,
  content: string,
): Promise<void> {
  const existing = await fs.readFile("plan", fileName, projectSlug);
  if (existing.ok && Buffer.from(existing.value).toString("utf-8") === content) return;
  const written = await fs.writeFile("plan", fileName, content, projectSlug);
  if (!written.ok) throw new Error(`Failed to write ${fileName}: ${written.error.message}`);
}

async function writePlanFiles(
  fs: VideocityFs,
  projectSlug: string,
  definition: PlanDefinition,
): Promise<void> {
  const project = await fs.getProject(projectSlug);
  if (!project.ok) throw new Error(project.error.message);
  await mkdir(join(project.value.path, "plan"), { recursive: true });

  const sidecar: NotebookPlanSidecar = {
    format: "notebook",
    schema_version: 1,
    definition,
  };
  await writePlanFileIfChanged(fs, projectSlug, "index.md", renderPlanMarkdown(definition));
  await writePlanFileIfChanged(fs, projectSlug, ".plan.json", JSON.stringify(sidecar, null, 2));
}

export {
  emptyPlanDefinition,
  isNotebookSidecar,
  planDefinitionSchema,
  renderPlanMarkdown,
  writePlanFiles,
};
export type { NotebookPlanSidecar, PlanDefinition, PlanStep };
