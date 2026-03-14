import type { ClipfirstFs } from "clipfirst-fs";
import type { ToolDef } from "./tool-def.js";

export function slugsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "slugs",
    description: "Return all project slugs.",
    schema: {},
    handler: async () => {
      const projects = await fs.listProjects();
      const slugs = projects.map((p) => p.slug);
      return {
        content: [{ type: "text" as const, text: JSON.stringify({ slugs }) }],
      };
    },
  };
}
