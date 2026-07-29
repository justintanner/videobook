import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  readTimeline,
  timelineFailure,
  timelineInput,
  timelinePayload,
  writeTimeline,
} from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

export function removeTimelineAudioDef(engine: Engine): ToolDef {
  return {
    name: "remove_timeline_audio",
    description: "Remove an audio overlay by its UUIDv7 id",
    schema: {
      book_id: z.string().uuid(),
      audio_id: z.string().uuid(),
    },
    handler: async (args) => {
      const timeline = readTimeline(engine);
      const audioId = String(args.audio_id);
      if (!timeline.audio.some((clip) => clip.id === audioId)) {
        return timelineFailure(`Timeline audio clip not found: ${audioId}`);
      }
      const result = await writeTimeline(engine, {
        ...timelineInput(timeline),
        audio: timeline.audio.filter((clip) => clip.id !== audioId).map((clip) => ({
          id: clip.id,
          artifactId: clip.artifactId,
          startFrame: clip.startFrame,
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
