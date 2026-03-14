import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function listProjectsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "list_projects",
    description: "List all clipfirst projects",
    schema: {
      sort: z.enum(["newest", "oldest"]).optional().describe("Sort order by creation date"),
    },
    handler: async (args) => {
      const { sort } = args as { sort?: "newest" | "oldest" };
      const projects = await fs.listProjects({ sort });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(projects) }],
      };
    },
  };
}

export function registerListProjectsTool(server: McpServer, fs: ClipfirstFs): void {
  const def = listProjectsDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
