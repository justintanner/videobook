import { z } from "zod";
import type { CostEstimate } from "@apicity/cost";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { getCostProvider } from "../cost.js";
import { getCostAdapter } from "../cost-adapters.js";

const callItem = z.object({
  tool_name: z.string().describe("Name of the generation tool whose cost to estimate"),
  input: z.record(z.string(), z.unknown()).describe("Same arguments object you'd pass to the generation tool"),
});

const schema = {
  calls: z
    .array(callItem)
    .min(1)
    .describe("One or more (tool_name, input) pairs. The result sums all entries."),
};

const UNKNOWN_ESTIMATE: CostEstimate = {
  usd: 0,
  currency: "USD",
  source: "free",
  breakdown: {},
  rateAsOf: null,
  warnings: [],
};

function unknown(toolName: string): CostEstimate {
  return {
    ...UNKNOWN_ESTIMATE,
    warnings: [`no cost adapter registered for tool '${toolName}'`],
  };
}

async function estimateOne(toolName: string, input: Record<string, unknown>): Promise<CostEstimate> {
  const adapter = getCostAdapter(toolName);
  if (!adapter) return unknown(toolName);
  const req = adapter(input);
  if (!req) return unknown(toolName);
  try {
    return await getCostProvider().usd(req);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      usd: 0,
      currency: "USD",
      source: "free",
      breakdown: {},
      rateAsOf: null,
      warnings: [`estimate failed: ${message}`],
    };
  }
}

function sumEstimates(estimates: CostEstimate[]): CostEstimate {
  if (estimates.length === 1) return estimates[0];
  const usd = estimates.reduce((acc, e) => acc + e.usd, 0);
  const warnings = estimates.flatMap((e) => e.warnings);
  // The summed result is unknown if every input was unknown, otherwise mixed.
  const allFree = estimates.every((e) => e.source === "free");
  const sources = new Set(estimates.map((e) => e.source));
  return {
    usd,
    currency: "USD",
    source: allFree ? "free" : sources.size === 1 ? estimates[0].source : "tokens-heuristic+table",
    breakdown: {},
    rateAsOf: estimates.find((e) => e.rateAsOf)?.rateAsOf ?? null,
    warnings,
  };
}

export function estimateCostDef(): ToolDef {
  return {
    name: "estimate_cost",
    description:
      "Estimate the USD cost of a generation tool call before invoking it. Accepts one or more " +
      "{tool_name, input} pairs and returns a single CostEstimate summed across all calls. Token-based " +
      "providers (openai/anthropic/xai) use a heuristic count (chars/4) and avoid upstream count-tokens " +
      "API hits. Tools without a registered cost adapter return a $0 estimate with a warning.",
    schema,
    handler: async (args): Promise<ToolResult> => {
      const calls = args.calls as Array<{ tool_name: string; input: Record<string, unknown> }>;
      const estimates = await Promise.all(calls.map((c) => estimateOne(c.tool_name, c.input)));
      const total = sumEstimates(estimates);
      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({
            estimate: total,
            per_call: estimates.map((e: CostEstimate, i: number) => ({ tool_name: calls[i].tool_name, estimate: e })),
          }),
        }],
      };
    },
  };
}
