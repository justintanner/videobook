import type { Sighting, SourceHealth, TrendingSchedule } from "./types.js";

export interface TrendingSource {
  id: string;
  sample(input: {
    country: string;
    window: TrendingSchedule["window"];
    limit: number;
    options?: Record<string, unknown>;
  }, context: { signal: AbortSignal }): Promise<{ capturedAt: string; sightings: Sighting[] }>;
  health(): SourceHealth;
}

export const trendingSources = new Map<string, TrendingSource>();
