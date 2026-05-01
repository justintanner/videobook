import { cost } from "@apicity/cost";
import type { CostProvider } from "@apicity/cost";

let cached: CostProvider | null = null;

export function getCostProvider(): CostProvider {
  if (cached) return cached;
  cached = cost();
  return cached;
}
