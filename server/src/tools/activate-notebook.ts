import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function activateNotebookDef(fs: VideocityFs): ToolDef {
  return {
    name: "activate_notebook",
    description: "Explicitly make a notebook the project capture target. Deleted or invalid targets resolve to scratch.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      notebook_id: z.string().describe("Asset ID of the notebook (e.g. nb-123)"),
    },
    handler: async (args) => {
      const { project_slug, notebook_id } = args as { project_slug: string; notebook_id: string; };
      
      const project = await fs.getProject(project_slug);
      if (!project.ok) {
        return { isError: true, content: [{ type: "text", text: project.error.message }] };
      }

      await fs.writeProjectMeta("last-active-notebook", { notebook_id }, project_slug);
      
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true, notebook_id }) }],
      };
    },
  };
}
