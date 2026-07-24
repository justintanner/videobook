import type {
  NotebookCell,
  NotebookDocument,
  NotebookEdge,
} from "videobook-engine";
import { z } from "zod";

// The canvas still uses a compact ordered-plan view. This adapter maps that
// view onto the engine's normalized notebook, cell, and edge tables. No
// notebook state is mirrored to artifact files.
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

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function documentName(
  definition: NotebookDefinition,
  fallback: string,
): string {
  return (
    stringValue(definition.properties.name) ??
    stringValue(definition.properties.title) ??
    fallback
  );
}

function notebookDocumentFromDefinition(
  base: NotebookDocument,
  definition: NotebookDefinition,
): NotebookDocument {
  const cellIds = new Set(definition.sequence.map((step) => step.id));
  const cells: NotebookCell[] = definition.sequence.map((step, index) => {
    const prompt =
      step.type === "prompt"
        ? stringValue(step.properties.text)
        : undefined;
    const model = stringValue(step.properties.model);
    const outputs = step.properties.asset_ids;
    const outputAssetId =
      Array.isArray(outputs) && typeof outputs[0] === "string"
        ? outputs[0]
        : undefined;
    return {
      id: step.id,
      type: step.type,
      title: step.name,
      position: { x: index * 320, y: 0 },
      inputs: step.properties,
      ...(prompt ? { prompt } : {}),
      ...(model ? { model } : {}),
      ...(outputAssetId ? { outputAssetId } : {}),
    };
  });
  const edges: NotebookEdge[] = [];
  for (const step of definition.sequence) {
    const inputs = step.properties.inputs;
    if (!Array.isArray(inputs)) continue;
    inputs.forEach((source, index) => {
      if (typeof source !== "string" || !cellIds.has(source)) return;
      edges.push({
        id: `${source}:${step.id}:${index}`,
        source,
        target: step.id,
        targetInput: `input-${index}`,
      });
    });
  }
  return {
    ...base,
    name: documentName(definition, base.name),
    properties: definition.properties,
    cells,
    edges,
    updatedAt: new Date().toISOString(),
  };
}

function notebookDefinitionFromDocument(
  document: NotebookDocument,
): NotebookDefinition {
  return {
    properties: document.properties ?? {},
    sequence: document.cells.map((cell) => {
      const properties = { ...(cell.inputs ?? {}) };
      if (
        cell.type === "prompt" &&
        cell.prompt !== undefined &&
        properties.text === undefined
      ) {
        properties.text = cell.prompt;
      }
      if (cell.model !== undefined && properties.model === undefined) {
        properties.model = cell.model;
      }
      if (
        cell.outputAssetId !== undefined &&
        properties.asset_ids === undefined
      ) {
        properties.asset_ids = [cell.outputAssetId];
      }
      return {
        id: cell.id,
        componentType: "task" as const,
        type: cell.type === "character" || cell.type === "scene"
          ? "asset" as const
          : cell.type,
        name: cell.title,
        properties,
      };
    }),
  };
}

export {
  emptyNotebookDefinition,
  notebookDefinitionFromDocument,
  notebookDefinitionSchema,
  notebookDocumentFromDefinition,
};
export type { NotebookDefinition, PlanStep };
