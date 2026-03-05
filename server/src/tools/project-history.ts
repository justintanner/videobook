import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";

export function registerProjectHistoryTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "project_history",
    "Get git commit history for a project",
    {
      project_slug: z.string().describe("Project slug"),
      limit: z.number().optional().describe("Max commits to return (default 20)"),
    },
    async ({ project_slug, limit }) => {
      const commits = await fs.getHistory(project_slug, limit ?? 20);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify(commits),
        }],
      };
    }
  );
}
