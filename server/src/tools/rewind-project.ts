import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";

export function registerRewindProjectTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "rewind_project",
    "Rewind a project to a previous git commit (creates detached HEAD)",
    {
      commit_hash: z.string().describe("Git commit hash to rewind to"),
      project_slug: z.string().describe("Project slug"),
    },
    async ({ commit_hash, project_slug }) => {
      const result = await fs.rewindProject(commit_hash, project_slug);
      if (!result) {
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: "Failed to rewind project. Check commit hash.",
          }],
        };
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            status: "rewound",
            project: project_slug,
            commit: commit_hash,
          }),
        }],
      };
    }
  );
}
