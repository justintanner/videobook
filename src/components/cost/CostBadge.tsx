import { RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import type { CostEstimate } from "@/hooks/useEstimateCost";
import { formatUsd, isHeuristic, isUnknownEstimate, tooltipText } from "@/lib/format-cost";

interface CostBadgeProps {
  estimate: CostEstimate | null;
  loading: boolean;
  error: string | null;
  stale: boolean;
  onRefresh: () => void;
  className?: string;
}

export function CostBadge({
  estimate,
  loading,
  error,
  stale,
  onRefresh,
  className,
}: CostBadgeProps) {
  const unknown = isUnknownEstimate(estimate);
  const heuristic = !!estimate && isHeuristic(estimate);
  const label = error
    ? "—"
    : unknown
      ? "—"
      : estimate
        ? `${heuristic ? "~" : ""}${formatUsd(estimate.usd)}`
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
 "inline-flex items-center justify-center size-3 rounded text-zinc-400 hover:text-zinc-100 transition-colors",
                loading && "animate-spin",
              )}
            >
 <RefreshCw className="size-2.5" />
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
