import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function projectHistoryDef(fs: ClipfirstFs): ToolDef {
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

export function registerProjectHistoryTool(server: McpServer, fs: ClipfirstFs): void {
  const def = projectHistoryDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
