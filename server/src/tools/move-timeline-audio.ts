import type { Engine } from "videobook-engine";
import { z } from "zod";
import { timelineFailure, timelineInput, timelinePayload } from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

export function moveTimelineAudioDef(engine: Engine): ToolDef {
  return {
    name: "move_timeline_audio",
    description: "Move an audio overlay to a frame offset",
    schema: {
      book_id: z.string().uuid(),
      audio_id: z.string().uuid(),
      start_frame: z.number().int().min(0),
    },
    handler: async (args) => {
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
          startFrame: clip.id === audioId ? args.start_frame as number : clip.startFrame,
          durationFrames: clip.durationFrames,
          ...(clip.volume === undefined ? {} : { volume: clip.volume }),
          ...(clip.fadeIn === undefined ? {} : { fadeIn: clip.fadeIn }),
          ...(clip.fadeOut === undefined ? {} : { fadeOut: clip.fadeOut }),
        })),
      });
      return result.ok ? {
        content: [{ type: "text", text: JSON.stringify(timelinePayload(result.value)) }],
      } : timelineFailure(result.error.message);
    },
  };
}
