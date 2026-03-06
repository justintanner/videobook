import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import type { ToolDef } from "./tool-def.js";

export function listProjectsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "list_projects",
    description: "List all clipfirst projects",
    schema: {},
    handler: async () => {
      const projects = await fs.listProjects();
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
