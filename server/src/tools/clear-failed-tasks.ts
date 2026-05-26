import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

export function clearFailedTasksDef(fs: VideocityFs): ToolDef {
  return {
    name: "clear_failed_tasks",
    description: "Delete all assets in the project that have a persisted generation-error.json. Returns the list of cleared asset ids.",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };

      const failuresRes = await fs.generationErrors.findAll(project_slug);
      const failures = failuresRes.ok ? failuresRes.value : [];

      const cleared: string[] = [];
      const errors: Array<{ assetId: string; message: string }> = [];

      for (const failure of failures) {
        const result = await fs.deleteAsset(failure.assetId, project_slug);
        if (result.ok) {
          cleared.push(failure.assetId);
        } else {
          errors.push({ assetId: failure.assetId, message: result.error.message });
        }
      }

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ cleared, errors }),
        }],
      };
    },
  };
}
