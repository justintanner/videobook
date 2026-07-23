import type {
  BookActionPhase,
  BookActionScope,
  EntityDocument,
  EntityType,
  NotebookDocument,
  VideobookFs,
} from "videobook-engine";
import { z } from "zod";

import { queue } from "../queue.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

const projectSchema = {
  project_slug: z.string().describe("Project slug"),
};

const bookPhaseSchema = z.enum([
  "requested",
  "started",
  "completed",
  "failed",
  "cancelled",
  "conflicted",
]);

const bookScopeSchema = z.enum([
  "project",
  "artifact",
  "layout",
  "external",
  "system",
]);

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function videobookDomainDefs(fs: VideobookFs): ToolDef[] {
  return [
    {
      name: "get_project_book",
      description: "Read the canonical project book and DoltLite action history",
      schema: {
        ...projectSchema,
        limit: z.number().int().positive().max(10_000).optional(),
        cursor: z.string().optional(),
      },
      handler: async (args) => {
        const result = await fs.getProjectBook(String(args.project_slug), {
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
          ...(typeof args.cursor === "string" ? { cursor: args.cursor } : {}),
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "get_book_action",
      description: "Read one logical project-book action and its lifecycle events",
      schema: { ...projectSchema, action_id: z.string() },
      handler: async (args) => {
        const result = await fs.getBookAction(
          String(args.project_slug),
          String(args.action_id),
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "record_book_action",
      description: "Append a permanent semantic action to the project book",
      schema: {
        ...projectSchema,
        action_id: z.string().optional(),
        operation: z.string().min(1),
        phase: bookPhaseSchema.optional(),
        scope: bookScopeSchema.optional(),
        actor: z.string().optional(),
        lane: z.string().optional(),
        base_revision: z.string().optional(),
        parent_action_ids: z.array(z.string()).optional(),
        input_artifact_ids: z.array(z.string()).optional(),
        output_artifact_ids: z.array(z.string()).optional(),
        target_artifact_id: z.string().optional(),
        target_action_id: z.string().optional(),
        stage: z.number().int().nonnegative().optional(),
        column: z.number().int().nonnegative().optional(),
        write_set: z.array(z.string()).optional(),
        details: z.record(z.string(), z.unknown()).optional(),
      },
      handler: async (args) => {
        const stage = typeof args.stage === "number" ? args.stage : undefined;
        const column = typeof args.column === "number" ? args.column : undefined;
        const result = await fs.recordBookAction({
          projectSlug: String(args.project_slug),
          operation: String(args.operation),
          ...(typeof args.action_id === "string"
            ? { actionId: args.action_id }
            : {}),
          ...(typeof args.phase === "string"
            ? { phase: args.phase as BookActionPhase }
            : {}),
          ...(typeof args.scope === "string"
            ? { scope: args.scope as BookActionScope }
            : {}),
          ...(typeof args.actor === "string" ? { actor: args.actor } : {}),
          ...(typeof args.lane === "string" ? { lane: args.lane } : {}),
          ...(typeof args.base_revision === "string"
            ? { baseRevision: args.base_revision }
            : {}),
          ...(Array.isArray(args.parent_action_ids)
            ? { parentActionIds: args.parent_action_ids as string[] }
            : {}),
          ...(Array.isArray(args.input_artifact_ids)
            ? { inputArtifactIds: args.input_artifact_ids as string[] }
            : {}),
          ...(Array.isArray(args.output_artifact_ids)
            ? { outputArtifactIds: args.output_artifact_ids as string[] }
            : {}),
          ...(typeof args.target_artifact_id === "string"
            ? { targetArtifactId: args.target_artifact_id }
            : {}),
          ...(typeof args.target_action_id === "string"
            ? { targetActionId: args.target_action_id }
            : {}),
          ...(stage !== undefined && column !== undefined
            ? { layout: { stage, column } }
            : {}),
          ...(Array.isArray(args.write_set)
            ? { writeSet: args.write_set as string[] }
            : {}),
          ...(args.details
            ? { details: args.details as Record<string, unknown> }
            : {}),
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "record_book_layout",
      description: "Record a permanent stage and column change in the project book",
      schema: {
        ...projectSchema,
        target_action_id: z.string(),
        stage: z.number().int().nonnegative(),
        column: z.number().int().nonnegative(),
        base_revision: z.string().optional(),
      },
      handler: async (args) => {
        const targetActionId = String(args.target_action_id);
        const result = await fs.recordBookAction({
          projectSlug: String(args.project_slug),
          operation: "move_entry",
          scope: "layout",
          actor: "human",
          lane: "human",
          ...(typeof args.base_revision === "string"
            ? { baseRevision: args.base_revision }
            : {}),
          targetActionId,
          layout: {
            stage: Number(args.stage),
            column: Number(args.column),
          },
          writeSet: [`layout:${targetActionId}`],
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "list_notebooks",
      description: "List first-class Videobook notebooks",
      schema: projectSchema,
      handler: async (args) =>
        json(await fs.listNotebooks(String(args.project_slug))),
    },
    {
      name: "create_notebook",
      description: "Create an empty version 2 notebook",
      schema: { ...projectSchema, name: z.string() },
      handler: async (args) => {
        const result = await fs.createNotebook(
          String(args.name),
          String(args.project_slug),
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "get_notebook",
      description: "Read a notebook and its typed cells and edges",
      schema: { ...projectSchema, notebook_id: z.string() },
      handler: async (args) => {
        const result = await fs.readNotebook(
          String(args.notebook_id),
          String(args.project_slug),
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "update_notebook",
      description: "Replace a notebook graph and create a revision",
      schema: {
        ...projectSchema,
        notebook: z.record(z.string(), z.unknown()),
      },
      handler: async (args) => {
        const result = await fs.writeNotebook(
          args.notebook as unknown as NotebookDocument,
          String(args.project_slug),
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "delete_notebook",
      description: "Tombstone a notebook asset",
      schema: { ...projectSchema, notebook_id: z.string() },
      handler: async (args) => {
        const result = await fs.deleteNotebook(
          String(args.notebook_id),
          String(args.project_slug),
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: "run_notebook",
      description: "Queue an explicit topological notebook run",
      schema: { ...projectSchema, notebook_id: z.string() },
      handler: async (args) => {
        try {
          const projectSlug = String(args.project_slug);
          const notebookId = String(args.notebook_id);
          const result = await queue.enqueueAndWait(
            `run-notebook-${notebookId}-${Date.now()}`,
            {
              type: "run_notebook",
              projectSlug,
              notebookId,
            },
          );
          return json(result);
        } catch (error) {
          return failure(error instanceof Error ? error.message : String(error));
        }
      },
    },
    {
      name: "list_jobs",
      description: "List persistent jobs for the active project",
      schema: projectSchema,
      handler: async (args) =>
        json(await fs.queue.list(String(args.project_slug))),
    },
    ...entityDefs(fs, "prompt"),
    ...entityDefs(fs, "scene"),
    ...entityDefs(fs, "character").map((definition) =>
      definition.name === "create_character"
        ? { ...definition, name: "create_character_entity" }
        : definition,
    ),
    {
      name: "storage_status",
      description: "Read DoltLite and content-store publication status",
      schema: {},
      handler: async () => json(await fs.getStorageStatus()),
    },
    {
      name: "storage_sync",
      description: "Publish pending content-addressed objects",
      schema: {},
      handler: async () => json(await fs.sync()),
    },
    {
      name: "revision_history",
      description: "Read the same canonical action history rendered by the project book",
      schema: {
        ...projectSchema,
        limit: z.number().int().positive().max(10_000).optional(),
      },
      handler: async (args) => {
        const result = await fs.getProjectBook(String(args.project_slug), {
          ...(typeof args.limit === "number" ? { limit: args.limit } : {}),
        });
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
  ];
}

function entityDefs(fs: VideobookFs, type: EntityType): ToolDef[] {
  const singular = type;
  const plural = type === "character" ? "characters" : `${type}s`;
  return [
    {
      name: `create_${singular}`,
      description: `Create a reusable ${singular}`,
      schema: {
        ...projectSchema,
        name: z.string(),
        description: z.string().optional(),
        prompt: z.string().optional(),
        data: z.record(z.string(), z.unknown()).optional(),
      },
      handler: async (args) => {
        const result = await fs.createEntity(
          type,
          String(args.name),
          String(args.project_slug),
          {
            ...(typeof args.description === "string"
              ? { description: args.description }
              : {}),
            ...(typeof args.prompt === "string" ? { prompt: args.prompt } : {}),
            ...(args.data ? { data: args.data as Record<string, unknown> } : {}),
          },
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `list_${plural}`,
      description: `List reusable ${plural}`,
      schema: projectSchema,
      handler: async (args) =>
        json(await fs.listEntities(String(args.project_slug), type)),
    },
    {
      name: `get_${singular}`,
      description: `Read a reusable ${singular}`,
      schema: { ...projectSchema, entity_id: z.string() },
      handler: async (args) => {
        const result = await fs.readEntity(
          String(args.entity_id),
          String(args.project_slug),
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `update_${singular}`,
      description: `Update a reusable ${singular}`,
      schema: {
        ...projectSchema,
        entity: z.record(z.string(), z.unknown()),
      },
      handler: async (args) => {
        const result = await fs.writeEntity(
          args.entity as unknown as EntityDocument,
          String(args.project_slug),
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
    {
      name: `delete_${singular}`,
      description: `Delete a reusable ${singular}`,
      schema: { ...projectSchema, entity_id: z.string() },
      handler: async (args) => {
        const result = await fs.deleteEntity(
          String(args.entity_id),
          String(args.project_slug),
        );
        return result.ok ? json(result.value) : failure(result.error.message);
      },
    },
  ];
}
