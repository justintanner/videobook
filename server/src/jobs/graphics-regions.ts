import type { Engine } from "videobook-engine";
import { findGraphicsRegions, GRAPHICS_REGIONS_JOB } from "../graphics/regions.js";
import { registerJobHandler } from "../queue.js";

export function registerGraphicsRegionsJob(engine: Engine): void {
  registerJobHandler(GRAPHICS_REGIONS_JOB, async (payload, context) => ({
    detected: await findGraphicsRegions(engine, String(payload.assetId), String(payload.mediaHash), payload.times as number[], context.signal),
  }));
}
