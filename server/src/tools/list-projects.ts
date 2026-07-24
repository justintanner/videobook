import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function listProjectsDef(fs: Engine): ToolDef {
  return {
    name: "list_projects",
    description: "List all videocity projects",
    schema: {
      sort: z.enum(["newest", "oldest"]).optional().describe("Sort order by creation date"),
    },
    handler: async (args) => {
      const { sort } = args as { sort?: "newest" | "oldest" };
      const projects = await fs.projects.list({ sort });
      const projectsWithAssetCounts = await Promise.all(
        projects.map(async (project) => {
          const [artifacts, notebooks] = await Promise.all([
            fs.artifacts.list(project.slug),
            fs.notebooks.list(project.slug),
          ]);
          return {
            ...project,
            asset_count: artifacts.length + notebooks.length,
          };
        }),
      );
      return {
        content: [{ type: "text" as const, text: JSON.stringify(projectsWithAssetCounts) }],
      };
    },
  };
}
