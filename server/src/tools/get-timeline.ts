import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

export function getTimelineDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "get_timeline",
    description: "Get the timeline for a project (array of slots with slug, volume, audioFadeIn, audioFadeOut)",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };

      const result = await fs.readProjectMeta<TimelineSlot[]>("timeline", project_slug);
      if (result.ok) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify(result.value) }],
        };
      }
      if (result.error.code === "NOT_FOUND") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify([]) }],
        };
      }
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: result.error.message }],
      };
    },
  };
}
