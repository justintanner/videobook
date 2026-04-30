import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CostEstimate, CostSource } from "@/hooks/useEstimateCost";

interface CostBadgeProps {
  estimate: CostEstimate | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  onRefresh: () => void;
  className?: string;
}

const HEURISTIC_SOURCES: ReadonlySet<CostSource> = new Set([
  "tokens-heuristic+table",
]);

function formatUsd(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

function tooltipText(estimate: CostEstimate): string {
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

export function CostBadge({
  estimate,
  loading,
  error,
  stale,
  onRefresh,
  className,
}: CostBadgeProps) {
  const isUnknown =
    !estimate ||
    (estimate.usd === 0 &&
      estimate.warnings.some((w) => w.includes("no cost adapter") || w.includes("not found in pricing table")));
  const isHeuristic = !!estimate && HEURISTIC_SOURCES.has(estimate.source);
  const label = error
    ? "—"
    : isUnknown
      ? "—"
      : estimate
        ? `${isHeuristic ? "~" : ""}${formatUsd(estimate.usd)}`
        : "…";

  const title = error
    ? error
    : estimate
      ? tooltipText(estimate)
      : "Estimating…";

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className={cn(
              "inline-flex items-center gap-1 px-1.5 py-0.5 rounded border text-[10px] font-mono leading-none",
              "border-zinc-700/60 bg-zinc-900/40 text-zinc-300",
              stale && "border-yellow-500/40 text-yellow-300",
              error && "border-red-500/40 text-red-300",
              className,
            )}
          >
            <span>{label}</span>
            <button
              type="button"
              tabIndex={-1}
              onClick={(e) => {
                e.stopPropagation();
                e.preventDefault();
                onRefresh();
              }}
              title="Recompute estimate"
              className={cn(
                "inline-flex items-center justify-center w-3 h-3 rounded text-zinc-400 hover:text-zinc-100 transition-colors",
                loading && "animate-spin",
              )}
            >
              <RefreshCw className="w-2.5 h-2.5" />
            </button>
          </span>
        </TooltipTrigger>
        <TooltipContent className="whitespace-pre-line max-w-xs text-[11px]">
          {title}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
