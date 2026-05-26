import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function listProjectsDef(fs: VideocityFs): ToolDef {
  return {
    name: "list_projects",
    description: "List all videocity projects",
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

export function registerListProjectsTool(server: McpServer, fs: VideocityFs): void {
  const def = listProjectsDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
