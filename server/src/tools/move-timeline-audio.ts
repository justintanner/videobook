import type { ClipfirstFs } from "clipfirst-engine";
import { z } from "zod";
import type { Orientation } from "../remotion/subtitles/types.js";
import type { ToolDef, ToolResult } from "./tool-def.js";

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

type ViewerSize = "landscape" | "portrait" | "square" | "original";

type TimelineConfig = {
  slots: TimelineSlot[];
  audio?: TimelineAudioClip[];
  render: Orientation;
  currentOrientation?: ViewerSize;
};

function toolError(msg: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text: msg }] };
}

function normalizeConfig(raw: TimelineConfig | TimelineSlot[]): TimelineConfig {
  if (Array.isArray(raw)) return { slots: raw, render: "landscape" };
  return {
    ...raw,
    render: Array.isArray(raw.render)
      ? ((raw.render as unknown as string[])[0] ?? "landscape") as Orientation
      : raw.render,
  };
}

export function moveTimelineAudioDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "move_timeline_audio",
    description: "Move a timeline audio clip to a new start frame",
    schema: {
      project_slug: z.string().describe("Project slug"),
      audio_id: z.string().describe("Timeline audio clip id"),
      start_frame: z.number().int().min(0).describe("New start frame (30 fps)"),
    },
    handler: async (args) => {
      const { project_slug, audio_id, start_frame } = args as {
        project_slug: string;
        audio_id: string;
        start_frame: number;
      };

      const readResult = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", project_slug);
      if (!readResult.ok) {
        const err = (readResult as { ok: false; error: { code: string; message: string } }).error;
        return toolError(err.code === "NOT_FOUND" ? "No timeline exists for this project" : err.message);
      }

      const config = normalizeConfig(readResult.value);
      const audio = config.audio ?? [];
      const idx = audio.findIndex((c) => c.id === audio_id);
      if (idx < 0) {
        return toolError(`Timeline audio clip "${audio_id}" not found`);
      }
      audio[idx] = { ...audio[idx], startFrame: start_frame };
      config.audio = audio;

      const writeResult = await fs.writeProjectMeta("timeline", config, project_slug);
      if (!writeResult.ok) {
        const writeErr = (writeResult as { ok: false; error: { message: string } }).error;
        return toolError(writeErr.message);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ clip: audio[idx], audio }) }],
      };
    },
  };
}
