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

type ViewerSize = 'landscape' | 'portrait' | 'square' | 'original';

type TimelineConfig = {
  slots: TimelineSlot[];
  render: Orientation;
  currentOrientation?: ViewerSize;
};

export function editTimelineDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "edit_timeline",
    description: "Set the timeline for a project (replaces all slots and render orientation)",
    schema: {
      project_slug: z.string().describe("Project slug"),
      slots: z.array(z.object({
        slug: z.string(),
        volume: z.number().optional(),
        audioFadeIn: z.number().optional(),
        audioFadeOut: z.number().optional(),
      })).describe("Timeline slots"),
      render: z.enum(["landscape", "portrait", "square"])
        .optional()
        .describe("Orientation to render (default: \"landscape\")"),
      currentOrientation: z.enum(["landscape", "portrait", "square", "original"])
        .optional()
        .describe("Last-used viewer orientation for clips"),
    },
    handler: async (args) => {
      const { project_slug, slots, render = "landscape", currentOrientation } = args as {
        project_slug: string;
        slots: TimelineSlot[];
        render?: Orientation;
        currentOrientation?: ViewerSize;
      };

      const config: TimelineConfig = { slots, render, ...(currentOrientation !== undefined && { currentOrientation }) };
      const result = await fs.writeProjectMeta("timeline", config, project_slug);
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
