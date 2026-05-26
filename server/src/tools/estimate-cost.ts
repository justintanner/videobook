import { z } from "zod";
import type { CostEstimate } from "@apicity/cost";
import type { VideocityFs } from "vc-engine";
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

// Tools where the model's billable duration is the input motion video's
// duration rather than a parameter the user types. The cost adapter still
// reads `input.duration`, so we enrich the input here (for the estimate only —
// the actual generation payload doesn't carry a duration field).
async function enrichInput(
  fs: VideocityFs,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (toolName !== "generate_kling30_motion_control_video") return input;
  if (typeof input.duration === "number") return input;

  const projectSlug = typeof input.project_slug === "string" ? input.project_slug : null;
  const motionSlugs = Array.isArray(input.motion_video_slugs)
    ? (input.motion_video_slugs as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (!projectSlug || motionSlugs.length === 0) return input;

  const meta = await fs.readMetadata(motionSlugs[0], "original", projectSlug);
  if (!meta.ok) return input;
  const duration = (meta.value as { duration?: unknown }).duration;
  if (typeof duration !== "number" || duration <= 0) return input;

  return { ...input, duration };
}

async function estimateOne(
  fs: VideocityFs,
  toolName: string,
  input: Record<string, unknown>,
): Promise<CostEstimate> {
  const adapter = getCostAdapter(toolName);
  if (!adapter) return unknown(toolName);
  const enriched = await enrichInput(fs, toolName, input);
  const req = adapter(enriched);
  if (!req) return unknown(toolName);
  return getCostProvider().estimate(req);
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

export function estimateCostDef(fs: VideocityFs): ToolDef {
  return {
    name: "estimate_cost",
    description:
      "Estimate the USD cost of a generation tool call before invoking it. Accepts one or more " +
      "{tool_name, input} pairs and returns a single CostEstimate summed across all calls. Token-based " +
      "providers (openai/anthropic/xai) use a chars/4 heuristic and price via a bundled local rate table. " +
      "Tools without a registered cost adapter return a $0 estimate with a warning.",
    schema,
    handler: async (args): Promise<ToolResult> => {
      const calls = args.calls as Array<{ tool_name: string; input: Record<string, unknown> }>;
      const estimates = await Promise.all(calls.map((c) => estimateOne(fs, c.tool_name, c.input)));
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
