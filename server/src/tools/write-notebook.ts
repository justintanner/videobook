import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { notebookDefinitionSchema, writeNotebookFiles } from "../notebook-store.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function writeNotebookDef(fs: VideocityFs): ToolDef {
  return {
    name: "write_notebook",
    description: "Write a Notebook sidecar (nb-*/.notebook.json). Creates a new notebook if notebook_id is omitted. Returns the notebook_id.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      notebook_id: z.string().optional().describe("Asset ID of the notebook to update. Omit to create a new one."),
      name: z.string().optional().describe("Name for the new notebook (only used when creating)"),
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
          content: [{ type: "text", text: parsed.error.issues.map((issue) => issue.message).join("; ") }],
        };
      }
      
      let targetId = notebook_id;
      if (!targetId) {
        const createResult = await fs.createAsset("nb", name ?? "notebook", project_slug);
        if (!createResult.ok) {
          return {
            isError: true,
            content: [{ type: "text", text: createResult.error.message }],
          };
        }
        targetId = createResult.value.assetId;
      }

      try {
        await writeNotebookFiles(fs, project_slug, targetId, parsed.data);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, steps: parsed.data.sequence.length, notebook_id: targetId }) }],
        };
      } catch (error) {
        return {
          isError: true,
          content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
        };
      }
    },
  };
}
