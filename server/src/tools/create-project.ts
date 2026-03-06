import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function createProjectDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "create_project",
    description: "Create a new clipfirst project directory with git versioning",
    schema: { slug: z.string().optional().describe("Project slug (auto-generated if omitted)") },
    handler: async (args) => {
      const { slug } = args as { slug?: string };
      const result = await fs.createProject(slug);
      if (result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
        };
      }
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: result.error.message }],
      };
    },
  };
}

export function registerCreateProjectTool(server: McpServer, fs: ClipfirstFs): void {
  const def = createProjectDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
