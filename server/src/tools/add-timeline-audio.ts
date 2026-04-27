import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import type { Orientation } from "../remotion/subtitles/types.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { findAudioFile } from "../media-files.js";
import { probeVideo } from "../ffmpeg.js";
import { scheduleTimelineRender } from "./schedule-timeline-render.js";

const TIMELINE_FPS = 30;

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

export function addTimelineAudioDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "add_timeline_audio",
    description: "Add an overlay audio clip to the timeline at a given frame offset",
    schema: {
      project_slug: z.string().describe("Project slug"),
      asset_id: z.string().describe("Audio asset id (must start with aud-)"),
      start_frame: z.number().int().min(0).describe("Start position in frames (30 fps)"),
      duration_frames: z.number().int().positive().optional().describe("Duration in frames; defaults to the audio file's native length"),
      volume: z.number().min(0).max(100).optional(),
      fade_in: z.number().min(0).optional().describe("Fade in (ms)"),
      fade_out: z.number().min(0).optional().describe("Fade out (ms)"),
    },
    handler: async (args) => {
      const { project_slug, asset_id, start_frame, duration_frames, volume, fade_in, fade_out } = args as {
        project_slug: string;
        asset_id: string;
        start_frame: number;
        duration_frames?: number;
        volume?: number;
        fade_in?: number;
        fade_out?: number;
      };

      if (!asset_id.startsWith("aud-")) {
        return toolError(`asset_id must be an aud-* asset, got: ${asset_id}`);
      }

      const manifestResult = await fs.getManifest(asset_id, project_slug);
      if (!manifestResult.ok) {
        return toolError(`Asset "${asset_id}" not found: ${manifestResult.error.message}`);
      }
      const manifest = manifestResult.value;
      const audioFile = findAudioFile(manifest.files, asset_id);
      if (!audioFile) {
        return toolError(`No audio file found in asset ${asset_id}`);
      }
      const audioPath = join(manifest.path, audioFile.name);

      let resolvedDurationFrames = duration_frames;
      if (resolvedDurationFrames === undefined) {
        try {
          const probe = await probeVideo(audioPath);
          resolvedDurationFrames = Math.max(1, Math.round(probe.duration * TIMELINE_FPS));
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          return toolError(`Failed to probe audio duration for ${asset_id}: ${msg}`);
        }
      }

      const readResult = await fs.readProjectMeta<TimelineConfig | TimelineSlot[]>("timeline", project_slug);
      let config: TimelineConfig;
      if (readResult.ok) {
        config = normalizeConfig(readResult.value);
      } else {
        const err = (readResult as { ok: false; error: { code: string; message: string } }).error;
        if (err.code === "NOT_FOUND") {
          config = { slots: [], render: "landscape" };
        } else {
          return toolError(err.message);
        }
      }

      const clip: TimelineAudioClip = {
        id: randomUUID(),
        slug: asset_id,
        startFrame: start_frame,
        durationFrames: resolvedDurationFrames,
        ...(volume !== undefined && { volume }),
        ...(fade_in !== undefined && { fadeIn: fade_in }),
        ...(fade_out !== undefined && { fadeOut: fade_out }),
      };

      config.audio = [...(config.audio ?? []), clip];

      const writeResult = await fs.writeProjectMeta("timeline", config, project_slug);
      if (!writeResult.ok) {
        const writeErr = (writeResult as { ok: false; error: { message: string } }).error;
        return toolError(writeErr.message);
      }

      scheduleTimelineRender(fs, project_slug);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ clip, audio: config.audio }) }],
      };
    },
  };
}
