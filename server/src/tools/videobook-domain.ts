import type {
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

function json(value: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(value) }] };
}

function failure(message: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

export function videobookDomainDefs(fs: VideobookFs): ToolDef[] {
  return [
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
    ...entityDefs(fs, "prompt"),
    ...entityDefs(fs, "scene"),
    ...entityDefs(fs, "character").filter(
      (definition) =>
        definition.name !== "create_character" &&
        definition.name !== "update_character",
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
      description: "List project revisions using storage-neutral terminology",
      schema: { ...projectSchema, limit: z.number().int().positive().optional() },
      handler: async (args) =>
        json(
          await fs.getProjectHistory(
            String(args.project_slug),
            typeof args.limit === "number" ? args.limit : undefined,
          ),
        ),
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
