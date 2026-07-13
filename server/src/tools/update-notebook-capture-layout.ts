import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function updateNotebookCaptureLayoutDef(fs: VideocityFs): ToolDef {
  return {
    name: "update_notebook_capture_layout",
    description: "Update positions for immutable capture nodes. Stores layout in notebook asset metadata so writes cannot overwrite .notebook.json.",
    schema: {
      project_slug: z.string().describe("Project slug"),
      notebook_id: z.string().describe("Asset ID of the notebook (e.g. nb-123)"),
      positions: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).describe("Node positions keyed by node ID"),
    },
    handler: async (args) => {
      const { project_slug, notebook_id, positions } = args as { project_slug: string; notebook_id: string; positions: Record<string, { x: number; y: number }> };
      
      const project = await fs.getProject(project_slug);
      if (!project.ok) {
        return { isError: true, content: [{ type: "text", text: project.error.message }] };
      }

      const writeResult = await fs.writeMetadata(notebook_id, "capture-layout", positions, project_slug);
      if (!writeResult.ok) {
        return { isError: true, content: [{ type: "text", text: writeResult.error.message }] };
      }
      
      return {
        content: [{ type: "text", text: JSON.stringify({ success: true }) }],
      };
    },
  };
}
