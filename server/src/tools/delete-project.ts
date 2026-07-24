import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function deleteProjectDef(fs: Engine): ToolDef {
  return {
    name: "delete_project",
    description:
      "Delete a videocity project directory. Validates slugs, checks for active asset locks, and updates the default project if needed.",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };
      const result = await fs.projects.delete(project_slug);
      if (result.ok) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(result.value) },
          ],
        };
      }
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: result.error.message }],
      };
    },
  };
}
