import type { VideobookFs, VideocityFs } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function createProjectDef(fs: VideocityFs): ToolDef {
  return {
    name: "create_project",
    description: "Create a fresh Videobook project with DoltLite revisions",
    schema: { project_slug: z.string().describe("Project slug") },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };
      const result = await fs.createProject(project_slug);
      if (result.ok) {
        const seed = await fs.writeProjectMeta("timeline", { slots: [], render: "landscape" }, project_slug);
        if (!seed.ok) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Project created but failed to seed timeline: ${seed.error.message}`,
            }],
          };
        }
        const notebook = await (fs as VideobookFs).createNotebook(
          "Scratch",
          project_slug,
        );
        if (!notebook.ok) {
          return {
            isError: true as const,
            content: [{
              type: "text" as const,
              text: `Project created but failed to seed notebook: ${notebook.error.message}`,
            }],
          };
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              ...result.value,
              notebook_id: notebook.value.id,
            }),
          }],
        };
      }
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: result.error.message }],
      };
    },
  };
}
