import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function projectActivityDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "project_activity",
    description: "Get the action log for a project (tool invocations with timestamps and payloads)",
    schema: {
      project_slug: z.string().describe("Project slug"),
      limit: z.number().optional().describe("Max entries to return (default 50)"),
    },
    handler: async (args) => {
      const { project_slug, limit } = args as { project_slug: string; limit?: number };
      const entries = await fs.getActionLog({ limit: limit ?? 50 }, project_slug);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(entries),
        }],
      };
    },
  };
}
