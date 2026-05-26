import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import type { Orientation } from "../remotion/subtitles/types.js";
import type { ToolDef } from "./tool-def.js";

type TimelineSlot = {
  slug: string;
  volume?: number;
  audioFadeIn?: number;
  audioFadeOut?: number;
};

type TimelineAudioClip = {
  id: string;
  slug: string;
  startFrame: number;
  durationFrames: number;
  volume?: number;
  fadeIn?: number;
  fadeOut?: number;
};

type ViewerSize = 'landscape' | 'portrait' | 'square' | 'original';

type TimelineConfig = {
  slots: TimelineSlot[];
  audio?: TimelineAudioClip[];
  render: Orientation;
  currentOrientation?: ViewerSize;
};

export function getTimelineDef(fs: VideocityFs): ToolDef {
  return {
    name: "get_timeline",
    description: "Get the timeline config for a project: { slots, render } where render is the orientation to produce",
    schema: {
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const { project_slug } = args as { project_slug: string };

      const result = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", project_slug);
      if (result.ok) {
        const config: TimelineConfig = Array.isArray(result.value)
          ? { slots: result.value, render: "landscape" }
          : { ...result.value, render: Array.isArray(result.value.render) ? ((result.value.render as unknown as string[])[0] ?? "landscape") as Orientation : result.value.render };
        return {
          content: [{ type: "text" as const, text: JSON.stringify(config) }],
        };
      }
      if (result.error.code === "NOT_FOUND") {
        const empty: TimelineConfig = { slots: [], render: "landscape" };
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
