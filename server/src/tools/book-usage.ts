import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { settleFinishedUsage, usageIncomplete } from "../provider-usage.js";

export function bookUsageDef(engine: Engine): ToolDef {
  return {
    name: "get_book_usage",
    description: "Read recorded provider tokens and USD cost for this book, with estimated and unavailable prices, activity/model breakdowns, and the latest 20 requests. Tracking starts when usage recording is enabled for this book.",
    schema: { book_id: z.string().uuid() },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: async () => {
      await settleFinishedUsage(engine);
      return {
        content: [{ type: "text", text: JSON.stringify({ ...engine.usage.summary(), recent: engine.usage.recent(), incomplete: usageIncomplete(engine) }) }],
      };
    },
  };
}
