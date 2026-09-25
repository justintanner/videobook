import type { Engine } from "videobook-engine";
import { z } from "zod";
import { slotIndex, timelineFailure } from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

export function insertTimelineSlotDef(_engine: Engine): ToolDef {
  return {
    name: "insert_timeline_slot",
    description: "Typed timelines cannot contain empty slots; assign an asset directly with assign_slot",
    schema: {
      book_id: z.string().uuid(),
      slot: z.string(),
      position: z.preprocess(
        (value) => typeof value === "string" ? value.trim().toLowerCase() : value,
        z.enum(["before", "after"]),
      ),
    },
    handler: async (args) => {
      const index = slotIndex(String(args.slot));
      if (index === null) return timelineFailure("Slot must use the form s01, s02, and so on");
      return timelineFailure("Empty slots are not supported by the typed v2 timeline; use assign_slot with an artifact");
    },
  };
}
