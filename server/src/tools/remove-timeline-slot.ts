import type { Engine } from "videobook-engine";
import { z } from "zod";
import {
  slotIndex,
  timelineFailure,
  timelineInput,
  timelineSuccess,
} from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

export function removeTimelineSlotDef(engine: Engine): ToolDef {
  return {
    name: "remove_timeline_slot",
    description: "Remove a typed timeline slot and shift later slots left",
    schema: {
      book_id: z.string().uuid(),
      slot: z.string(),
    },
    handler: async (args) => {
      const index = slotIndex(String(args.slot));
      if (index === null) return timelineFailure("Slot must use the form s01, s02, and so on");
      const timeline = engine.timeline.get();
      if (index >= timeline.slots.length) {
        return timelineFailure(`Slot ${String(args.slot)} is outside the current timeline`);
      }
      const removed = timeline.slots[index]!;
      const result = await engine.timeline.set({
        ...timelineInput(timeline),
        slots: timeline.slots.filter((_, position) => position !== index).map((slot) => ({
          id: slot.id,
          artifactId: slot.artifactId,
          ...(slot.volume === undefined ? {} : { volume: slot.volume }),
          ...(slot.audioFadeIn === undefined ? {} : { audioFadeIn: slot.audioFadeIn }),
          ...(slot.audioFadeOut === undefined ? {} : { audioFadeOut: slot.audioFadeOut }),
        })),
      });
      if (!result.ok) return timelineFailure(result.error.message);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ ...JSON.parse(timelineSuccess(result.value).content[0]!.text), removed_artifact_id: removed.artifactId }),
        }],
      };
    },
  };
}
