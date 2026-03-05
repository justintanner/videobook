import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";

export function registerListProjectsTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "list_projects",
    "List all clipfirst projects",
    {},
    async () => {
      const projects = await fs.listProjects();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(projects) }],
      };
    }
  );
}
