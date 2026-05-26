import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function switchProjectDef(fs: VideocityFs): ToolDef {
  return {
    name: "switch_project",
    description:
      "Switch the active (default) project to the given slug.",
    schema: {
      project_slug: z.string().describe("Project slug to switch to"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };
      const result = await fs.switchProject(project_slug);
      if (result.ok) {
        return {
          content: [
            { type: "text" as const, text: JSON.stringify({ success: true }) },
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
