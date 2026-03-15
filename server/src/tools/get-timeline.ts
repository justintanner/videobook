import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { Orientation } from "../remotion/subtitles/types.js";
import type { ToolDef } from "./tool-def.js";

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

type TimelineConfig = {
  slots: TimelineSlot[];
  render: Orientation[];
};

export function getTimelineDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "get_timeline",
    description: "Get the timeline config for a project: { slots, render } where render is an array of orientations to produce",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };

      const result = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", project_slug);
      if (result.ok) {
        const config: TimelineConfig = Array.isArray(result.value)
          ? { slots: result.value, render: ["landscape"] }
          : result.value;
        return {
          content: [{ type: "text" as const, text: JSON.stringify(config) }],
        };
      }
      if (result.error.code === "NOT_FOUND") {
        const empty: TimelineConfig = { slots: [], render: ["landscape"] };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(empty) }],
        };
      }
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: result.error.message }],
      };
    },
  };
}
