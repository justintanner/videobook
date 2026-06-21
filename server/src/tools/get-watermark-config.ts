import type { ToolDef } from "./tool-def.js";
import { readWatermarkConfig } from "../watermark-config.js";

/**
 * Return the persisted watermark handle preferences so the /watermark dialog can
 * default to the saved / last-used X handle and list recent handles to pick from.
 */
export function getWatermarkConfigDef(): ToolDef {
  return {
    name: "get_watermark_config",
    description:
      "Read the saved watermark X-handle preferences: { savedHandle, recent }. Used to pre-fill the /watermark dialog.",
    schema: {},
    handler: async () => {
      const config = await readWatermarkConfig();
      return {
        content: [{ type: "text" as const, text: JSON.stringify(config) }],
      };
    },
  };
}
