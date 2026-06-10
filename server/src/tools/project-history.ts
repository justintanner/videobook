import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function projectHistoryDef(fs: VideocityFs): ToolDef {
  return {
    name: "project_history",
    description: "Get git commit history for a project",
    schema: {
      project_slug: z.string().describe("Project slug"),
      limit: z.number().optional().describe("Max commits to return (default 20)"),
    },
    handler: async (args) => {
      const { project_slug, limit } = args as { project_slug: string; limit?: number };
      const commits = await fs.getHistory(project_slug, limit ?? 20);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(commits),
        }],
      };
    },
  };
}

