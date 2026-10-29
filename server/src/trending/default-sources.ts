import { getApiKey, isPlaceholderApiKey } from "../api-key.js";
import type { TrendingSchedule } from "./types.js";

const omkarPackage = ["@apicity", "omkar"].join("/");
const freeSources: TrendingSchedule["sources"] = [
  { id: "endless" },
  { id: "tiktok-creative-center" },
];

function usableKey(value: string | null | undefined): value is string {
  return Boolean(value) && !isPlaceholderApiKey(value ?? "");
}

function packageInstalled(name: string): boolean {
  try {
    import.meta.resolve(name);
    return true;
  } catch {
    return false;
  }
}

export function omkarSourceAvailability(probe: {
  apiKey?: string | null;
  packageInstalled?: boolean;
} = {}): "configured" | "not configured" | "not installed" {
  const apiKey = probe.apiKey === undefined ? getApiKey("OMKAR_API_KEY") : probe.apiKey;
  const installed = probe.packageInstalled ?? packageInstalled(omkarPackage);
  if (!installed) return "not installed";
  if (!usableKey(apiKey)) return "not configured";
  return "configured";
}

export function defaultTrendingSources(probe: {
  apiKey?: string | null;
  packageInstalled?: boolean;
} = {}): TrendingSchedule["sources"] {
  if (omkarSourceAvailability(probe) !== "configured") return freeSources;
  return [...freeSources, { id: "omkar" }];
}
