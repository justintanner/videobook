import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import type { ToolDef } from "./tool-def.js";

export function getDefaultProjectDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "get_default_project",
    description: "Get the default clipfirst project",
    schema: {},
    handler: async () => {
      const result = await fs.getProject();
      if (result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
        };
      }

      // Auto-create project if not found
      if (result.error.code === "NOT_FOUND") {
        const createResult = await fs.createProject();
        if (createResult.ok) {
          const newProject = await fs.getProject(createResult.value.slug);
          if (newProject.ok) {
            return {
              content: [{ type: "text" as const, text: JSON.stringify(newProject.value) }],
            };
          }
        }
      }

      return {
        isError: true as const,
        content: [{ type: "text" as const, text: result.error.message }],
      };
    },
  };
}

export function registerGetDefaultProjectTool(server: McpServer, fs: ClipfirstFs): void {
  const def = getDefaultProjectDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
