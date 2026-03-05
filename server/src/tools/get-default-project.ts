import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";

export function registerGetDefaultProjectTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "get_default_project",
    "Get the default clipfirst project",
    {},
    async () => {
      const result = await fs.getProject();
      if (result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
        };
      }
      return {
        isError: true,
        content: [{ type: "text" as const, text: result.error.message }],
      };
    }
  );
}
