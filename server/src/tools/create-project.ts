import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function createProjectDef(fs: VideocityFs): ToolDef {
  return {
    name: "create_project",
    description: "Create a new videocity project directory with git versioning",
    schema: { project_slug: z.string().describe("Project slug") },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };
      const result = await fs.createProject(project_slug);
      if (result.ok) {
        await fs.writeProjectMeta("timeline", { slots: [], render: "landscape" }, project_slug);
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

