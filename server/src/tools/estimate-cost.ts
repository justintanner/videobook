import { z } from "zod";
import type { CostEstimate } from "@apicity/cost";
import type { VideocityFs } from "videocity-engine";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { getCostProvider } from "../cost.js";
import { getCostAdapter } from "../cost-adapters.js";
import { estimateGoogleFlowCost } from "../google-flow-cost.js";

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

async function enrichMotionControlInput(
  fs: VideocityFs,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof input.duration === "number") return input;

  const projectSlug = typeof input.project_slug === "string" ? input.project_slug : null;
  const motionSlugs = Array.isArray(input.motion_video_slugs)
    ? (input.motion_video_slugs as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (!projectSlug || motionSlugs.length === 0) return input;

  const motionSlug = motionSlugs[0].replace(/^@/, "");
  const meta = await fs.readMetadata(motionSlug, "original", projectSlug);
  if (!meta.ok) return input;
  const duration = (meta.value as { duration?: unknown }).duration;
  if (typeof duration !== "number" || duration <= 0) return input;

  return { ...input, duration };
}

async function enrichGrokExtendInput(
  fs: VideocityFs,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof input.resolution === "string" && input.resolution) return input;
  const projectSlug = typeof input.project_slug === "string" ? input.project_slug : null;
  const source = typeof input.video_slug === "string"
    ? input.video_slug
    : typeof input.asset_id === "string"
      ? input.asset_id
      : null;
  if (!projectSlug || !source) return input;

  const assetId = source.replace(/^@/, "");
  const meta = await fs.readMetadata<{ resolution?: unknown; input?: { resolution?: unknown } }>(
    assetId,
    "generation-payload",
    projectSlug,
  );
  if (!meta.ok) return input;
  const resolution = meta.value.input?.resolution ?? meta.value.resolution;
  return typeof resolution === "string" && resolution
    ? { ...input, resolution }
    : input;
}

// happyhorse/video-edit has no user-typed duration — the output matches the
// source video. Source the duration from the selected video asset's `original`
// metadata so the displayed cost matches what the paygate will bound against
// (the job handler resolves the same value and passes it as a cost hint).
async function enrichHappyHorseVideoEditInput(
  fs: VideocityFs,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof input.duration === "number") return input;

  const projectSlug = typeof input.project_slug === "string" ? input.project_slug : null;
  const videoSlug = typeof input.video_slug === "string" ? input.video_slug : null;
  if (!projectSlug || !videoSlug) return input;

  const assetId = videoSlug.replace(/^@/, "");
  if (!assetId.startsWith("vid-")) return input;

  const meta = await fs.readMetadata<{ duration?: unknown }>(assetId, "original", projectSlug);
  if (!meta.ok) return input;
  const duration = meta.value.duration;
  if (typeof duration !== "number" || duration <= 0) return input;

  return { ...input, duration };
}

async function enrichInput(
  fs: VideocityFs,
  toolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (toolName === "generate_kling30_motion_control_video") {
    return enrichMotionControlInput(fs, input);
  }
  if (toolName === "extend_grok_imagine_video") {
    return enrichGrokExtendInput(fs, input);
  }
  if (toolName === "generate_happyhorse_videoedit_video") {
    return enrichHappyHorseVideoEditInput(fs, input);
  }
  return input;
}

async function estimateOne(
  fs: VideocityFs,
  toolName: string,
  input: Record<string, unknown>,
): Promise<CostEstimate> {
  // Google Flow: local credits→USD table (apicity has no google provider).
  const flow = estimateGoogleFlowCost(toolName, input);
  if (flow) return flow;

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
