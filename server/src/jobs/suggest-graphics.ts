import type { Engine } from "videobook-engine";
import { getApiKey } from "../api-key.js";
import type { GraphicsSuggestRequest } from "../graphics/suggest.js";
import { GRAPHICS_SUGGEST_JOB, graphicsSuggestResponses, suggestGraphicsText } from "../graphics/suggest.js";
import { registerJobHandler } from "../queue.js";

export function registerSuggestGraphicsJob(engine: Engine): void {
  registerJobHandler(GRAPHICS_SUGGEST_JOB, async (payload, context) => suggestGraphicsText(
    engine,
    String(payload.assetId),
    payload.request as GraphicsSuggestRequest,
    graphicsSuggestResponses(getApiKey("OPENAI_API_KEY") ?? undefined),
    context.signal,
  ));
}
