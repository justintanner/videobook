import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import { emptyNotebookDefinition, isNotebookSidecar } from "../notebook-store.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function isMissingNotebookError(error: { code?: string; message: string }): boolean {
  return error.code === "NOT_FOUND" || error.message.includes("File not found");
}

function missingNotebookResponse(legacy = false): Record<string, unknown> {
  return {
    exists: false,
    ...(legacy ? { legacy: true } : {}),
    definition: emptyNotebookDefinition(),
  };
}

export function readNotebookDef(fs: VideocityFs): ToolDef {
  return {
    name: "read_notebook",
    description: "Read a Notebook sidecar (nb-*/.notebook.json).",
    schema: {
      project_slug: z.string().describe("Project slug"),
      notebook_id: z.string().describe("Asset ID of the notebook (e.g. nb-123)"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { project_slug, notebook_id } = args as { project_slug: string; notebook_id: string; };
      const project = await fs.getProject(project_slug);
      if (!project.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: project.error.message }],
        };
      }

      const result = await fs.readFile(notebook_id, ".notebook.json", project_slug);
      if (!result.ok) {
        if (isMissingNotebookError(result.error)) {
          return {
            content: [{ type: "text", text: JSON.stringify(missingNotebookResponse()) }],
          };
        }
        return {
          isError: true,
          content: [{ type: "text", text: result.error.message }],
        };
      }

      let sidecar: unknown;
      try {
        sidecar = JSON.parse(Buffer.from(result.value).toString("utf-8"));
      } catch {
        return {
          content: [{ type: "text", text: JSON.stringify(missingNotebookResponse(true)) }],
        };
      }
      if (!isNotebookSidecar(sidecar)) {
        return {
          content: [{ type: "text", text: JSON.stringify(missingNotebookResponse(true)) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ exists: true, definition: sidecar.definition }) }],
      };
    },
  };
}
