import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function listProjectsDef(fs: VideocityFs): ToolDef {
  return {
    name: "list_projects",
    description: "List all videocity projects",
    schema: {
      sort: z.enum(["newest", "oldest"]).optional().describe("Sort order by creation date"),
    },
    handler: async (args) => {
      const { sort } = args as { sort?: "newest" | "oldest" };
      const projects = await fs.listProjects({ sort });
      const projectsWithAssetCounts = await Promise.all(
        projects.map(async (project) => {
          const assets = await fs.listAssets(project.slug);
          return { ...project, asset_count: assets.length };
        }),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(projectsWithAssetCounts) }],
      };
    },
  };
}

