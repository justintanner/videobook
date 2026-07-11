import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { emptyPlanDefinition, isNotebookSidecar } from "../plan-notebook.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

function isMissingPlanError(error: { code?: string; message: string }): boolean {
  return error.code === "NOT_FOUND" || error.message.includes("File not found: plan/.plan.json");
}

function missingPlanResponse(legacy = false): Record<string, unknown> {
  return {
    exists: false,
    ...(legacy ? { legacy: true } : {}),
    definition: emptyPlanDefinition(),
  };
}

export function readPlanDef(fs: VideocityFs): ToolDef {
  return {
    name: "read_plan",
    description: "Read the project Notebook sidecar (plan/.plan.json).",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args): Promise<ToolResult> => {
      const { project_slug } = args as { project_slug: string };
      const project = await fs.getProject(project_slug);
      if (!project.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: project.error.message }],
        };
      }

      const result = await fs.readFile("plan", ".plan.json", project_slug);
      if (!result.ok) {
        if (isMissingPlanError(result.error)) {
          return {
            content: [{ type: "text", text: JSON.stringify(missingPlanResponse()) }],
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
          content: [{ type: "text", text: JSON.stringify(missingPlanResponse(true)) }],
        };
      }
      if (!isNotebookSidecar(sidecar)) {
        return {
          content: [{ type: "text", text: JSON.stringify(missingPlanResponse(true)) }],
        };
      }
      return {
        content: [{ type: "text", text: JSON.stringify({ exists: true, definition: sidecar.definition }) }],
      };
    },
  };
}
