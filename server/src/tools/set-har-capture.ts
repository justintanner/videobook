import { z } from "zod";
import { harSettingsSchema, readHarSettings, writeHarSettings, harDirectory } from "../har-settings.js";
import { appState, type ApplicationStateStore } from "../app-state.js";
import type { ToolDef } from "./tool-def.js";

export function setHarCaptureDef(store: ApplicationStateStore = appState): ToolDef {
  return {
    name: "set_har_capture",
    description: "Read or change opt-in local provider HAR diagnostics. Captures retain prompts, media URLs, parameters, responses and errors; secrets, cookies and oversized media bytes are scrubbed. Omit mode to read settings. Environment override wins.",
    schema: {
      mode: harSettingsSchema.shape.mode.removeDefault().optional(),
      maxAgeDays: harSettingsSchema.shape.maxAgeDays.removeDefault().optional(),
      maxTotalMB: harSettingsSchema.shape.maxTotalMB.removeDefault().optional(),
    },
    handler: async (args) => {
      try {
        const changes = z.object({
          mode: harSettingsSchema.shape.mode.removeDefault().optional(),
          maxAgeDays: harSettingsSchema.shape.maxAgeDays.removeDefault().optional(),
          maxTotalMB: harSettingsSchema.shape.maxTotalMB.removeDefault().optional(),
        }).parse(args);
        const settings = Object.values(changes).some((value) => value !== undefined)
          ? await writeHarSettings({ ...await readHarSettings(store, {}), ...changes }, store)
          : await readHarSettings(store);
        return { content: [{ type: "text", text: JSON.stringify({ ...settings, dir: harDirectory(), overridden: Boolean(process.env.VIDEOBOOK_HAR_CAPTURE?.trim()) }) }] };
      } catch (error) {
        return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
      }
    },
  };
}
