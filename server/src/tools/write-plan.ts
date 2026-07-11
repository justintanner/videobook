import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { planDefinitionSchema, writePlanFiles } from "../plan-notebook.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

export function writePlanDef(fs: VideocityFs): ToolDef {
  return {
    name: "write_plan",
    description: "Write a project Notebook definition and its markdown mirror.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      definition: planDefinitionSchema,
    },
    handler: async (args): Promise<ToolResult> => {
      const { project_slug, definition } = args as {
        project_slug: string;
        definition: unknown;
      };
      const parsed = planDefinitionSchema.safeParse(definition);
      if (!parsed.success) {
        return {
          isError: true,
          content: [{ type: "text", text: parsed.error.issues.map((issue) => issue.message).join("; ") }],
        };
      }
      try {
        await writePlanFiles(fs, project_slug, parsed.data);
        return {
          content: [{ type: "text", text: JSON.stringify({ ok: true, steps: parsed.data.sequence.length }) }],
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
