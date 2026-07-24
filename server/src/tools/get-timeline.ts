import type { Engine } from "videobook-engine";
import { z } from "zod";
import { timelineSuccess } from "../timeline-helpers.js";
import type { ToolDef } from "./tool-def.js";

export function getTimelineDef(engine: Engine): ToolDef {
  return {
    name: "get_timeline",
    description: "Get the selected book's typed v2 timeline",
    schema: {
      book_id: z.string().uuid(),
    },
    handler: async () => timelineSuccess(engine.timeline.get()),
  };
}
