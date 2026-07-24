import type { Engine } from "videobook-engine";
import type { ToolDef } from "./tool-def.js";

export function getDefaultProjectDef(fs: Engine): ToolDef {
  return {
    name: "ensure_default_project",
    description: "Return the default Videobook project, creating it when none exists",
    schema: {},
    handler: async () => {
      const result = await fs.projects.get();
      if (result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
        };
      }

      // Auto-create project if not found
      if (result.error.code === "NOT_FOUND") {
        const createResult = await fs.projects.create();
        if (createResult.ok) {
          const newProject = await fs.projects.get(createResult.value.slug);
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
