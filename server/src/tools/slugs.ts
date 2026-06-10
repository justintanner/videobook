import type { VideocityFs } from "videocity-engine";
import type { ToolDef } from "./tool-def.js";

export function slugsDef(fs: VideocityFs): ToolDef {
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
