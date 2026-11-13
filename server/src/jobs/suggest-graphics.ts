import type { Engine } from "videobook-engine";
import { getApiKey } from "../api-key.js";
import type { GraphicsSuggestRequest } from "../graphics/suggest.js";
import { GRAPHICS_SUGGEST_JOB, graphicsSuggestResponses, suggestGoalTitles, suggestGraphicsText } from "../graphics/suggest.js";
import { registerJobHandler } from "../queue.js";

export function registerSuggestGraphicsJob(engine: Engine): void {
  registerJobHandler(GRAPHICS_SUGGEST_JOB, async (payload, context) => {
    const responses = graphicsSuggestResponses(getApiKey("OPENAI_API_KEY") ?? undefined);
    if (typeof payload.goalId === "string") return suggestGoalTitles(engine, payload.goalId, responses, context.signal);
    return suggestGraphicsText(engine, String(payload.assetId), payload.request as GraphicsSuggestRequest, responses, context.signal);
  });
}
