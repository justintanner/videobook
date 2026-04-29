import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function renameProjectDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "rename_project",
    description:
      "Atomically rename a project directory. Validates slugs, checks for active asset locks, and updates the default project if needed.",
    schema: {
      old_slug: z.string().describe("Current project slug"),
      new_slug: z.string().describe("Desired new project slug"),
    },
    handler: async (args) => {
      const { old_slug, new_slug } = args as {
        old_slug: string;
        new_slug: string;
      };
      const result = await fs.renameProject(old_slug, new_slug);
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
