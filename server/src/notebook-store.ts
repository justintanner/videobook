import type { VideocityFs } from "videobook-engine";
import { z } from "zod";

// Mirrors src/components/center-stage/notebook/types.ts.
interface PlanStep {
  id: string;
  componentType: "task";
  type: "prompt" | "image" | "video" | "asset";
  name: string;
  properties: Record<string, unknown>;
}

interface NotebookDefinition {
  properties: Record<string, unknown>;
  sequence: PlanStep[];
}

interface NotebookPlanSidecar {
  format: "notebook";
  schema_version: 1;
  definition: NotebookDefinition;
}

const planStepSchema = z.object({
  id: z.string(),
  componentType: z.literal("task"),
  type: z.enum(["prompt", "image", "video", "asset"]),
  name: z.string(),
  properties: z.record(z.string(), z.unknown()),
}).strict();

const notebookDefinitionSchema = z.object({
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

function emptyNotebookDefinition(): NotebookDefinition {
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

function renderInputReference(inputId: string, steps: PlanStep[]): string {
  const inputIndex = steps.findIndex((step) => step.id === inputId);
  if (inputIndex === -1) return inputId;
  const input = steps[inputIndex];
  if (input.type === "asset") {
    const slug = stringProperty(input.properties, "slug");
    return slug ? formatAssetRef(slug) : `#${inputIndex + 1} ${input.name}`;
  }
  return `#${inputIndex + 1} ${input.name}`;
}

function renderAssetMarkdown(step: PlanStep): string[] {
  const slug = stringProperty(step.properties, "slug");
  return [`- **Asset:** ${slug ? formatAssetRef(slug) : "—"}`];
}

function renderGenerationMarkdown(step: PlanStep, steps: PlanStep[]): string[] {
  const values = valuesProperty(step.properties);
  const refs = [
    ...stringArrayProperty(values, "image_slugs"),
    ...[stringProperty(values, "first_frame_slug"), stringProperty(values, "video_slug")]
      .filter((value): value is string => value !== null),
  ];
  const assetIds = stringArrayProperty(step.properties, "asset_ids");
  const inputs = stringArrayProperty(step.properties, "inputs");
  const model = stringProperty(step.properties, "model") ?? "—";
  const prompt = stringProperty(values, "prompt");

  return [
    `- **Model:** ${model}`,
    `- **Inputs:** ${inputs.length > 0 ? inputs.map((input) => renderInputReference(input, steps)).join(", ") : "—"}`,
    `- **Refs:** ${refs.length > 0 ? refs.join(", ") : "—"}`,
    `- **Produces:** ${assetIds.length > 0 ? assetIds.map(formatAssetRef).join(", ") : "—"}`,
    ...(prompt ? ["", `> ${prompt}`] : []),
  ];
}

function renderNotebookMarkdown(definition: NotebookDefinition): string {
  if (definition.sequence.length === 0) {
    return ["# Notebook", "", "0 steps", "", "_No steps yet._", ""].join("\n");
  }

  return [
    "# Notebook",
    "",
    `${definition.sequence.length} steps`,
    "",
    ...definition.sequence.flatMap((step, index) => [
      `## ${index + 1}. ${step.name} — ${step.type}`,
      "",
      ...(step.type === "prompt"
        ? renderPromptMarkdown(step)
        : step.type === "asset"
          ? renderAssetMarkdown(step)
          : renderGenerationMarkdown(step, definition.sequence)),
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
async function writeNotebookFileIfChanged(
  fs: VideocityFs,
  projectSlug: string,
  notebookId: string,
  fileName: string,
  content: string,
): Promise<void> {
  const existing = await fs.readFile(notebookId, fileName, projectSlug);
  if (existing.ok && Buffer.from(existing.value).toString("utf-8") === content) return;
  const written = await fs.writeFile(notebookId, fileName, content, projectSlug);
  if (!written.ok) throw new Error(`Failed to write ${fileName}: ${written.error.message}`);
}

async function writeNotebookFiles(
  fs: VideocityFs,
  projectSlug: string,
  notebookId: string,
  definition: NotebookDefinition,
): Promise<void> {
  const sidecar: NotebookPlanSidecar = {
    format: "notebook",
    schema_version: 1,
    definition,
  };
  await writeNotebookFileIfChanged(fs, projectSlug, notebookId, "index.md", renderNotebookMarkdown(definition));
  await writeNotebookFileIfChanged(fs, projectSlug, notebookId, ".notebook.json", JSON.stringify(sidecar, null, 2));
}

export {
  emptyNotebookDefinition,
  isNotebookSidecar,
  notebookDefinitionSchema,
  renderNotebookMarkdown,
  writeNotebookFiles,
};
export type { NotebookPlanSidecar, NotebookDefinition, PlanStep };
