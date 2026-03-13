import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { performSync } from "./sync.js";

export function switchProjectDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "switch_project",
    description:
      "Switch the active (default) project to the given slug. Returns sync data for the new project.",
    schema: {
      project_slug: z.string().describe("Project slug to switch to"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };
      const result = await fs.switchProject(project_slug);
      if (result.ok) {
        const syncResult = await performSync(fs, project_slug);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(syncResult) },
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
