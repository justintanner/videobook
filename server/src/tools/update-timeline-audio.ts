import type { Engine } from "videobook-engine";
import { z } from "zod";
import { timelineFailure, timelineInput, timelinePayload } from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

export function updateTimelineAudioDef(engine: Engine): ToolDef {
  return {
    name: "update_timeline_audio",
    description: "Update an audio overlay's volume or fades",
    schema: {
      book_id: z.string().uuid(),
      audio_id: z.string().uuid(),
      volume: z.number().min(0).max(100).optional(),
      fade_in: z.number().min(0).optional(),
      fade_out: z.number().min(0).optional(),
    },
    handler: async (args) => {
      if (args.volume === undefined && args.fade_in === undefined && args.fade_out === undefined) {
        return timelineFailure("Provide volume, fade_in, or fade_out");
      }
      const timeline = engine.timeline.get();
      const audioId = String(args.audio_id);
      if (!timeline.audio.some((clip) => clip.id === audioId)) {
        return timelineFailure(`Timeline audio clip not found: ${audioId}`);
      }
      const result = await engine.timeline.set({
        ...timelineInput(timeline),
        audio: timeline.audio.map((clip) => ({
          id: clip.id,
          artifactId: clip.artifactId,
          startFrame: clip.startFrame,
          durationFrames: clip.durationFrames,
          ...(clip.id === audioId && args.volume !== undefined ? { volume: args.volume as number } : clip.volume === undefined ? {} : { volume: clip.volume }),
          ...(clip.id === audioId && args.fade_in !== undefined ? { fadeIn: args.fade_in as number } : clip.fadeIn === undefined ? {} : { fadeIn: clip.fadeIn }),
          ...(clip.id === audioId && args.fade_out !== undefined ? { fadeOut: args.fade_out as number } : clip.fadeOut === undefined ? {} : { fadeOut: clip.fadeOut }),
        })),
      });
      return result.ok ? {
        content: [{ type: "text", text: JSON.stringify(timelinePayload(result.value)) }],
      } : timelineFailure(result.error.message);
    },
  };
}
