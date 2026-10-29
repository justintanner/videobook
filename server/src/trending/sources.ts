import { endlessSource } from "./sources/endless.js";
import { omkarSource } from "./sources/omkar.js";
import { tiktokCreativeCenterSource } from "./sources/tiktok-creative-center.js";
import type { Sighting, SourceHealth, TrendingLedger, TrendingSchedule } from "./types.js";

export interface TrendingSource {
  id: string;
  sample(input: {
    country: string;
    window: TrendingSchedule["window"];
    limit: number;
    options?: Record<string, unknown>;
  }, context: { signal: AbortSignal; previousHealth?: SourceHealth }): Promise<{ capturedAt: string; sightings: Sighting[]; details?: NonNullable<TrendingLedger["sourceDetails"]>[string] } | undefined>;
  health(): SourceHealth;
}

export const trendingSources = new Map<string, TrendingSource>([
  ["endless", endlessSource()],
  ["tiktok-creative-center", tiktokCreativeCenterSource()],
  ["omkar", omkarSource()],
]);
