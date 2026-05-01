import type { CostEstimate, CostSource } from "@/hooks/useEstimateCost";

const HEURISTIC_SOURCES: ReadonlySet<CostSource> = new Set([
  "tokens-heuristic+table",
]);

export function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

export function isHeuristic(estimate: CostEstimate): boolean {
  return HEURISTIC_SOURCES.has(estimate.source);
}

export function isUnknownEstimate(estimate: CostEstimate | null): boolean {
  if (!estimate) return true;
  if (estimate.usd !== 0) return false;
  return estimate.warnings.some(
    (w) => w.includes("no cost adapter") || w.includes("not found in pricing table"),
  );
}

export function tooltipText(estimate: CostEstimate): string {
  const lines: string[] = [];
  lines.push(`Source: ${estimate.source}`);
  if (estimate.rateAsOf) lines.push(`Rates as of: ${estimate.rateAsOf}`);
  const b = estimate.breakdown;
  if (b.inputTokens !== undefined) lines.push(`Input tokens: ${b.inputTokens}`);
  if (b.outputTokens !== undefined) lines.push(`Output tokens: ${b.outputTokens}`);
  if (b.units !== undefined && b.unit) lines.push(`Units: ${b.units} ${b.unit}`);
  if (b.inputUsdPerMillion !== undefined) lines.push(`Input $/M: ${b.inputUsdPerMillion}`);
  if (b.outputUsdPerMillion !== undefined) lines.push(`Output $/M: ${b.outputUsdPerMillion}`);
  if (b.perUnitUsd !== undefined) lines.push(`Per unit: $${b.perUnitUsd}`);
  if (estimate.warnings.length > 0) {
    lines.push("");
    lines.push("Warnings:");
    for (const w of estimate.warnings) lines.push(`• ${w}`);
  }
  return lines.join("\n");
}
