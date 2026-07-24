import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  emptyNotebookDefinition,
  notebookDefinitionFromDocument,
} from "../notebook-store.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function readNotebookDef(fs: Engine): ToolDef {
  return {
    name: "read_notebook",
    description: "Read a normalized Dolt-native notebook.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      notebook_id: z.string().describe("Stable notebook UUID"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { project_slug, notebook_id } = args as {
        project_slug: string;
        notebook_id: string;
      };
      const project = await fs.projects.get(project_slug);
      if (!project.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: project.error.message }],
        };
      }
      const result = fs.notebooks.read(notebook_id, project_slug);
      if (!result.ok) {
        if (result.error.code === "NOT_FOUND") {
          return {
            content: [{
              type: "text",
              text: JSON.stringify({
                exists: false,
                definition: emptyNotebookDefinition(),
              }),
            }],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: result.error.message }],
        };
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            exists: true,
            definition: notebookDefinitionFromDocument(result.value),
          }),
        }],
      };
    },
  };
}
