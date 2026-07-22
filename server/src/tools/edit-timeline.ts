import type { VideocityFs } from "videocity-engine";
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

export function setTimelineDef(fs: VideocityFs): ToolDef {
  return {
    name: "set_timeline",
    description: "Set the timeline for a project (replaces all slots and render orientation; unspecified optional fields like audio are preserved)",
    schema: {
      project_slug: z.string().describe("Project slug"),
      slots: z.array(z.object({
        slug: z.string(),
        volume: z.number().optional(),
        audioFadeIn: z.number().optional(),
        audioFadeOut: z.number().optional(),
      })).describe("Timeline slots"),
      audio: z.array(z.object({
        id: z.string(),
        slug: z.string(),
        startFrame: z.number(),
        durationFrames: z.number(),
        volume: z.number().optional(),
        fadeIn: z.number().optional(),
        fadeOut: z.number().optional(),
      })).optional().describe("Overlay audio clips on the timeline"),
      render: z.enum(["landscape", "portrait", "square"])
        .optional()
        .describe("Orientation to render (default: \"landscape\")"),
      currentOrientation: z.enum(["landscape", "portrait", "square", "original"])
        .optional()
        .describe("Last-used viewer orientation for clips"),
    },
    handler: async (args) => {
      const { project_slug, slots, audio, render = "landscape", currentOrientation } = args as {
        project_slug: string;
        slots: TimelineSlot[];
        audio?: TimelineAudioClip[];
        render?: Orientation;
        currentOrientation?: ViewerSize;
      };

      // Preserve optional fields the caller didn't send — a partial update
      // (e.g. orientation only) must not wipe existing audio clips.
      const existingResult = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", project_slug);
      const existing: TimelineConfig | undefined =
        existingResult.ok && !Array.isArray(existingResult.value)
          ? existingResult.value
          : undefined;

      const mergedAudio = audio ?? existing?.audio;
      const mergedOrientation = currentOrientation ?? existing?.currentOrientation;
      const config: TimelineConfig = {
        slots,
        render,
        ...(mergedAudio !== undefined && { audio: mergedAudio }),
        ...(mergedOrientation !== undefined && { currentOrientation: mergedOrientation }),
      };
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

export function editTimelineDef(fs: VideocityFs): ToolDef {
  const base = setTimelineDef(fs);
  return {
    ...base,
    name: "edit_timeline",
    description: "Legacy alias for set_timeline. Set the timeline for a project.",
  };
}
