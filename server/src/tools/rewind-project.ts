import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function rewindProjectDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "rewind_project",
    description: "Rewind a project to a previous git commit (creates detached HEAD)",
    schema: {
      commit_hash: z.string().describe("Git commit hash to rewind to"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { commit_hash, project_slug } = args as { commit_hash: string; project_slug: string };
      const result = await fs.rewindProject(commit_hash, project_slug);
      if (!result) {
        return {
          isError: true as const,
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
    },
  };
}

export function registerRewindProjectTool(server: McpServer, fs: ClipfirstFs): void {
  const def = rewindProjectDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
