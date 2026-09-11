import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { findAudioFile } from "videobook-engine";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import { probeVideo } from "../ffmpeg.js";
import {
  readTimeline,
  resolveArtifact,
  timelineFailure,
  timelineInput,
  timelinePayload,
  writeTimeline,
} from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

export function addTimelineAudioDef(engine: Engine): ToolDef {
  return {
    name: "add_timeline_audio",
    description: "Add a typed audio overlay to the selected book timeline",
    schema: {
      book_id: z.string().uuid(),
      asset_id: z.string(),
      start_frame: z.number().int().min(0),
      duration_frames: z.number().int().positive().optional(),
      volume: z.number().min(0).max(100).optional(),
      fade_in: z.number().min(0).optional(),
      fade_out: z.number().min(0).optional(),
    },
    handler: async (args) => {
      const asset = resolveArtifact(engine, String(args.asset_id));
      if (!asset || asset.kind !== "audio") {
        return timelineFailure(`Audio artifact not found: ${String(args.asset_id)}`);
      }
      const manifest = await engine.files.manifest(asset.artifactId);
      if (!manifest.ok) return timelineFailure(manifest.error.message);
      const audioFile = findAudioFile(manifest.value.files, asset.kind);
      if (!audioFile) return timelineFailure(`No audio file found in ${asset.label ?? asset.artifactId}`);
      let durationFrames = args.duration_frames as number | undefined;
      if (durationFrames === undefined) {
        try {
          const probe = await probeVideo(join(manifest.value.path, audioFile.name));
          const { frameRate } = engine.sequences.getPrimary();
          durationFrames = Math.max(1, Math.round(
            (probe.audioDuration ?? probe.duration) * frameRate.numerator / frameRate.denominator,
          ));
        } catch (error) {
          return timelineFailure(error instanceof Error ? error.message : String(error));
        }
      }
      const timeline = readTimeline(engine);
      const clipId = uuidv7();
      const audio = [
        ...timeline.audio.map((clip) => ({
          id: clip.id,
          artifactId: clip.artifactId,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          ...(clip.volume === undefined ? {} : { volume: clip.volume }),
          ...(clip.fadeIn === undefined ? {} : { fadeIn: clip.fadeIn }),
          ...(clip.fadeOut === undefined ? {} : { fadeOut: clip.fadeOut }),
        })),
        {
          id: clipId,
          artifactId: asset.artifactId,
          startFrame: args.start_frame as number,
          durationFrames,
          ...(args.volume === undefined ? {} : { volume: args.volume as number }),
          ...(args.fade_in === undefined ? {} : { fadeIn: args.fade_in as number }),
          ...(args.fade_out === undefined ? {} : { fadeOut: args.fade_out as number }),
        },
      ];
      const result = await writeTimeline(engine, { ...timelineInput(timeline), audio });
      if (!result.ok) return timelineFailure(result.error.message);
      const clip = result.value.audio.find((item) => item.id === clipId);
      return {
        content: [{ type: "text", text: JSON.stringify({ ...timelinePayload(result.value), clip }) }],
      };
    },
  };
}
