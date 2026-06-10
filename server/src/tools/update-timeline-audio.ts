import type { VideocityFs } from "videocity-engine";
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

export function updateTimelineAudioDef(fs: VideocityFs): ToolDef {
  return {
    name: "update_timeline_audio",
    description: "Update an overlay audio clip's volume / fade-in / fade-out by id",
    schema: {
      project_slug: z.string().describe("Project slug"),
      audio_id: z.string().describe("Timeline audio clip id"),
      volume: z.number().min(0).max(100).optional(),
      fade_in: z.number().min(0).optional().describe("Fade in (ms)"),
      fade_out: z.number().min(0).optional().describe("Fade out (ms)"),
    },
    handler: async (args) => {
      const { project_slug, audio_id, volume, fade_in, fade_out } = args as {
        project_slug: string;
        audio_id: string;
        volume?: number;
        fade_in?: number;
        fade_out?: number;
      };

      if (volume === undefined && fade_in === undefined && fade_out === undefined) {
        return toolError("update_timeline_audio: nothing to update (provide volume, fade_in, or fade_out)");
      }

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

      const next: TimelineAudioClip = { ...audio[idx] };
      if (volume !== undefined) next.volume = volume;
      if (fade_in !== undefined) next.fadeIn = fade_in;
      if (fade_out !== undefined) next.fadeOut = fade_out;
      audio[idx] = next;
      config.audio = audio;

      const writeResult = await fs.writeProjectMeta("timeline", config, project_slug);
      if (!writeResult.ok) {
        const writeErr = (writeResult as { ok: false; error: { message: string } }).error;
        return toolError(writeErr.message);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ clip: next, audio }) }],
      };
    },
  };
}
