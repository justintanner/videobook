import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  notebookDefinitionSchema,
  notebookDocumentFromDefinition,
} from "../notebook-store.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function writeNotebookDef(fs: Engine): ToolDef {
  return {
    name: "write_notebook",
    description:
      "Create or replace a normalized Dolt-native notebook graph.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      notebook_id: z.string().optional().describe(
        "Stable notebook UUID to update; omit to create.",
      ),
      name: z.string().optional().describe("Name for a new notebook"),
      definition: notebookDefinitionSchema,
    },
    handler: async (args): Promise<ToolResult> => {
      const { project_slug, notebook_id, name, definition } = args as {
        project_slug: string;
        notebook_id?: string;
        name?: string;
        definition: unknown;
      };
      const parsed = notebookDefinitionSchema.safeParse(definition);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{
            type: "text",
            text: parsed.error.issues.map((issue) => issue.message).join("; "),
          }],
        };
      }

      const existing = notebook_id
        ? fs.notebooks.read(notebook_id, project_slug)
        : await fs.notebooks.create(name ?? "Notebook", project_slug);
      if (!existing.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: existing.error.message }],
        };
      }
      const document = notebookDocumentFromDefinition(
        existing.value,
        parsed.data,
      );
      const written = await fs.notebooks.write(document, project_slug);
      if (!written.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: written.error.message }],
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ok: true,
            steps: parsed.data.sequence.length,
            notebook_id: document.id,
            revision: written.value.hash,
          }),
        }],
      };
    },
  };
}
