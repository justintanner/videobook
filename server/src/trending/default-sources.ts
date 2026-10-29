import { createRequire } from "node:module";
import { getApiKey, isPlaceholderApiKey } from "../api-key.js";
import type { TrendingSchedule } from "./types.js";

const require = createRequire(import.meta.url);
const freeSources: TrendingSchedule["sources"] = [
  { id: "endless" },
  { id: "tiktok-creative-center" },
];

function usableKey(value: string | null | undefined): value is string {
  return Boolean(value) && !isPlaceholderApiKey(value ?? "");
}

function packageInstalled(name: string): boolean {
  try {
    require.resolve(name);
    return true;
  } catch {
    return false;
  }
}

export function defaultTrendingSources(probe: {
  apiKey?: string | null;
  packageInstalled?: boolean;
} = {}): TrendingSchedule["sources"] {
  const apiKey = probe.apiKey === undefined ? getApiKey("OMKAR_API_KEY") : probe.apiKey;
  const omkarPackage = ["@apicity", "omkar"].join("/");
  const installed = probe.packageInstalled ?? packageInstalled(omkarPackage);
  if (!usableKey(apiKey) || !installed) return freeSources;
  return [...freeSources, { id: "omkar" }];
}
