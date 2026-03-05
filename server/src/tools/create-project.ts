import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";

export function registerCreateProjectTool(server: McpServer, fs: ClipfirstFs): void {
  server.tool(
    "create_project",
    "Create a new clipfirst project directory with git versioning",
    { slug: z.string().optional().describe("Project slug (auto-generated if omitted)") },
    async ({ slug }) => {
      const result = await fs.createProject(slug);
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
