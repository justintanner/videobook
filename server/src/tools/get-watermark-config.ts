import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { readWatermarkConfig, setAuthenticatedHandle } from "../watermark-config.js";
import { fetchAuthenticatedXHandle } from "../x/authenticated-handle.js";

/**
 * Return the persisted watermark handle preferences so the chat watermark review can
 * default to the saved / last-used X handle and list recent handles to pick from.
 *
 * `authenticatedHandle` is read-through cached: we try @apicity/x's /2/users/me
 * live and update the cache on success; on any failure we fall back to the last
 * cached value (null on first-ever call).
 */
export function getWatermarkConfigDef(engine: Engine): ToolDef {
  return {
    name: "get_watermark_config",
    description:
      "Read the saved watermark X-handle preferences: { savedHandle, recent, authenticatedHandle }. Used to pre-fill the chat watermark review.",
    schema: { book_id: z.string().describe("Book UUID") },
    handler: async () => {
      const cached = await readWatermarkConfig(engine);
      const live = await fetchAuthenticatedXHandle();
      const authenticatedHandle = live !== null
        ? (await setAuthenticatedHandle(live, engine)).authenticatedHandle
        : cached.authenticatedHandle;
      const config = { ...cached, authenticatedHandle };
      return {
        content: [{ type: "text" as const, text: JSON.stringify(config) }],
      };
    },
  };
}
