import { join } from "node:path";
import { z } from "zod";
import { appState, type ApplicationStateStore } from "./app-state.js";
import { dataLayout } from "./data-home.js";

export const harSettingsSchema = z.object({
  mode: z.enum(["off", "failures", "all"]).default("off"),
  maxAgeDays: z.number().positive().finite().default(30),
  maxTotalMB: z.number().positive().finite().default(512),
});
export type HarSettings = z.infer<typeof harSettingsSchema>;

export function harDirectory(): string {
  const layout = dataLayout();
  return join(layout.root, ...(layout.kind === "checkout" ? ["runtime"] : []), "har");
}

export async function readHarSettings(store: ApplicationStateStore = appState, env: NodeJS.ProcessEnv = process.env): Promise<HarSettings> {
  const stored = harSettingsSchema.safeParse(await store.get("harCapture") ?? {});
  const settings = stored.success ? stored.data : harSettingsSchema.parse({});
  const override = env.VIDEOBOOK_HAR_CAPTURE?.trim();
  if (!override) return settings;
  const mode = harSettingsSchema.shape.mode.safeParse(override);
  return { ...settings, mode: mode.success ? mode.data : "off" };
}

export async function writeHarSettings(value: unknown, store: ApplicationStateStore = appState): Promise<HarSettings> {
  const settings = harSettingsSchema.parse(value);
  await store.set("harCapture", settings);
  return readHarSettings(store);
}
