import type { Engine, UsageEntry, UsageRollupFilter } from "videobook-engine";
import { z } from "zod";
import type { ToolDef } from "./tool-def.js";
import { settleFinishedUsage, usageIncomplete } from "../provider-usage.js";

const SCOPE_CALLS = 200;

function scopeUsage(engine: Engine, filter: UsageRollupFilter, matches: (entry: UsageEntry) => boolean) {
  return { totals: engine.usage.rollup(filter).totals, calls: engine.usage.recent(SCOPE_CALLS).filter(matches).reverse() };
}

export function notBilledCallsByJob(engine: Engine): Map<string, UsageEntry[]> {
  const calls = new Map<string, UsageEntry[]>();
  for (const entry of engine.usage.recent(SCOPE_CALLS).reverse()) {
    if (!entry.jobId || entry.basis !== "free" || entry.status !== "failed") continue;
    calls.set(entry.jobId, [...(calls.get(entry.jobId) ?? []), entry]);
  }
  return calls;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function scopeArgs(value: unknown): { cellId?: string; runId?: string } {
  const scope = value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
  const cellId = text(scope.cell_id);
  const runId = text(scope.run_id);
  return { ...(cellId ? { cellId } : {}), ...(runId ? { runId } : {}) };
}

export function bookUsageDef(engine: Engine): ToolDef {
  return {
    name: "get_book_usage",
    description: "Read recorded provider tokens and USD cost for this book, with estimated and unavailable prices, activity/model breakdowns, the latest 20 requests, and totals that set quoted estimates against actuals. Pass scope.cell_id or scope.run_id to add that notebook cell's or run's totals and its calls among the latest 200. Tracking starts when usage recording is enabled for this book.",
    schema: {
      book_id: z.string().uuid(),
      scope: z.object({
        cell_id: z.string().min(1).max(500).optional().describe("Notebook cell whose cost totals and calls to add"),
        run_id: z.string().min(1).max(500).optional().describe("Notebook run whose cost totals and calls to add"),
      }).optional().describe("Notebook cell or run to add cost totals and calls for"),
    },
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    handler: async (args) => {
      await settleFinishedUsage(engine);
      const { cellId, runId } = scopeArgs(args.scope);
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            ...engine.usage.summary(),
            rollup: engine.usage.rollup().totals,
            recent: engine.usage.recent(),
            incomplete: usageIncomplete(engine),
            ...(cellId ? { cell: { id: cellId, ...scopeUsage(engine, { cellId }, (entry) => entry.cellId === cellId) } } : {}),
            ...(runId ? { run: { id: runId, ...scopeUsage(engine, { runId }, (entry) => entry.runId === runId) } } : {}),
          }),
        }],
      };
    },
  };
}
