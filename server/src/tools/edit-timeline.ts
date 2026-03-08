import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

export function editTimelineDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "edit_timeline",
    description: "Set the timeline for a project (replaces all slots)",
    schema: {
      project_slug: z.string().describe("Project slug"),
      slots: z.array(z.object({
        slug: z.string(),
        volume: z.number().optional(),
        audioFadeIn: z.number().optional(),
        audioFadeOut: z.number().optional(),
      })).describe("Timeline slots"),
    },
    handler: async (args) => {
      const { project_slug, slots } = args as {
        project_slug: string;
        slots: TimelineSlot[];
      };

      const result = await fs.writeProjectMeta("timeline", slots, project_slug);
      if (result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ path: result.value }) }],
        };
      }
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: result.error.message }],
      };
    },
  };
}
