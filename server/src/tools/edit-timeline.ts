import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  timelineFailure,
  timelineSuccess,
  type TimelineInput,
  writeTimeline,
} from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

const slotSchema = z.object({
  id: z.string().uuid().optional(),
  artifact_id: z.string().uuid(),
  volume: z.number().min(0).optional(),
  audioFadeIn: z.number().min(0).optional(),
  audioFadeOut: z.number().min(0).optional(),
});

const audioSchema = z.object({
  id: z.string().uuid().optional(),
  artifact_id: z.string().uuid(),
  startFrame: z.number().int().min(0),
  durationFrames: z.number().int().positive(),
  volume: z.number().min(0).optional(),
  fadeIn: z.number().min(0).optional(),
  fadeOut: z.number().min(0).optional(),
});

export function setTimelineDef(engine: Engine): ToolDef {
  return {
    name: "set_timeline",
    description: "Replace a book's typed v2 timeline using stable artifact UUIDs",
    schema: {
      book_id: z.string().uuid(),
      render: z.enum(["landscape", "portrait", "square"]),
      slots: z.array(slotSchema).optional(),
      audio: z.array(audioSchema).optional(),
    },
    handler: async (args) => {
      const slots = args.slots as Array<z.infer<typeof slotSchema>> | undefined;
      const audio = args.audio as Array<z.infer<typeof audioSchema>> | undefined;
      const input: TimelineInput = {
        render: args.render as TimelineInput["render"],
        ...(slots === undefined ? {} : {
          slots: slots.map((slot) => ({
            ...(slot.id ? { id: slot.id } : {}),
            artifactId: slot.artifact_id,
            ...(slot.volume === undefined ? {} : { volume: slot.volume }),
            ...(slot.audioFadeIn === undefined ? {} : { audioFadeIn: slot.audioFadeIn }),
            ...(slot.audioFadeOut === undefined ? {} : { audioFadeOut: slot.audioFadeOut }),
          })),
        }),
        ...(audio === undefined ? {} : {
          audio: audio.map((clip) => ({
            ...(clip.id ? { id: clip.id } : {}),
            artifactId: clip.artifact_id,
            startFrame: clip.startFrame,
            durationFrames: clip.durationFrames,
            ...(clip.volume === undefined ? {} : { volume: clip.volume }),
            ...(clip.fadeIn === undefined ? {} : { fadeIn: clip.fadeIn }),
            ...(clip.fadeOut === undefined ? {} : { fadeOut: clip.fadeOut }),
          })),
        }),
      };
      const result = await writeTimeline(engine, input);
      return result.ok ? timelineSuccess(result.value) : timelineFailure(result.error.message);
    },
  };
}
