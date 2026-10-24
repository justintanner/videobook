import type { Engine } from "videobook-engine";
import { z } from "zod";
import { generationCaptureKeys, generationHar } from "../generation-har.js";
import { readHarSettings } from "../har-settings.js";
import type { ToolDef } from "./tool-def.js";

function errorResult(message: string) {
  return { isError: true as const, content: [{ type: "text" as const, text: message }] };
}

export function getGenerationHarDef(engine: Engine): ToolDef {
  return {
    name: "get_generation_har",
    description: "Return the scrubbed provider HAR capture of one generation attempt, by attempt id or asset id. Several captured calls are combined into one HAR with a page per call. Needs provider capture (set_har_capture).",
    schema: {
      book_id: z.string().describe("Book id"),
      generation_id: z.string().min(1).describe("Generation attempt id or its asset id"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (args) => {
      const { generation_id } = args as { book_id: string; generation_id: string };
      try {
        const result = await generationHar(await generationCaptureKeys(engine, generation_id), generation_id);
        if (!result) {
          const { mode } = await readHarSettings();
          return errorResult(mode === "off"
            ? "No HAR capture for this generation. Provider capture is off; turn it on in Settings > Diagnostics or with set_har_capture."
            : "No HAR capture for this generation.");
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({
              generationId: generation_id,
              filename: `videobook-generation-${generation_id.replace(/[^A-Za-z0-9._-]+/gu, "-")}.har`,
              captures: result.captures,
              har: result.har,
            }),
          }],
        };
      } catch (error) {
        return errorResult(error instanceof Error ? error.message : String(error));
      }
    },
  };
}
