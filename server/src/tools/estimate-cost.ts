import { z } from "zod";
import type { CostEstimate } from "@apicity/cost";
import type { ArtifactKind, Engine } from "videobook-engine";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { artifactKindOf } from "./_shared.js";
import { getCostProvider } from "../cost.js";
import { getCostAdapter } from "../cost-adapters.js";
import { estimateGoogleFlowCost } from "../google-flow-cost.js";
import { getCanonicalName } from "../generation-registry.js";
import type { BookManager } from "../book-manager.js";
import { referenceVideoDuration } from "../reference-video-duration.js";

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
  engine: Engine,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof input.duration === "number") return input;

  const bookId = typeof input.book_id === "string" ? input.book_id : null;
  const motionSlugs = Array.isArray(input.motion_video_refs)
    ? (input.motion_video_refs as unknown[]).filter((s): s is string => typeof s === "string")
    : [];
  if (!bookId || motionSlugs.length === 0) return input;

  const motionSlug = motionSlugs[0].replace(/^@/, "");
  const meta = await engine.metadata.artifacts.read(motionSlug, "original");
  if (!meta.ok) return input;
  const duration = (meta.value as { duration?: unknown }).duration;
  if (typeof duration !== "number" || duration <= 0) return input;

  return { ...input, duration };
}

async function enrichGrokExtendInput(
  engine: Engine,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof input.resolution === "string" && input.resolution) return input;
  const bookId = typeof input.book_id === "string" ? input.book_id : null;
  const source = typeof input.video_ref === "string"
    ? input.video_ref
    : typeof input.asset_id === "string"
      ? input.asset_id
      : null;
  if (!bookId || !source) return input;

  const assetId = source.replace(/^@/, "");
  const meta = await engine.metadata.artifacts.read<{ resolution?: unknown; input?: { resolution?: unknown } }>(assetId, "generation-payload"
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
  engine: Engine,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  if (typeof input.duration === "number") return input;

  const bookId = typeof input.book_id === "string" ? input.book_id : null;
  const videoRef = typeof input.video_ref === "string" ? input.video_ref : null;
  if (!bookId || !videoRef) return input;

  const assetId = videoRef.replace(/^@/, "");
  if (artifactKindOf(engine, assetId) !== "video") return input;

  const meta = await engine.metadata.artifacts.read<{ duration?: unknown }>(assetId, "original");
  if (!meta.ok) return input;
  const duration = meta.value.duration;
  if (typeof duration !== "number" || duration <= 0) return input;

  return { ...input, duration };
}

async function enrichSourceDuration(
  engine: Engine,
  input: Record<string, unknown>,
  refField: string,
  expectedKind: ArtifactKind,
): Promise<Record<string, unknown>> {
  if (typeof input.duration === "number") return input;
  const bookId = typeof input.book_id === "string" ? input.book_id : null;
  const raw = typeof input[refField] === "string" ? input[refField] as string : null;
  if (!bookId || !raw) return input;
  const assetId = raw.replace(/^@/, "");
  if (artifactKindOf(engine, assetId) !== expectedKind) return input;
  const meta = await engine.metadata.artifacts.read<{ duration?: unknown }>(assetId, "original");
  if (!meta.ok) return input;
  const duration = meta.value.duration;
  if (typeof duration !== "number" || duration <= 0) return input;
  return { ...input, duration };
}

async function enrichInput(
  engine: Engine,
  rawToolName: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const toolName = getCanonicalName(rawToolName);
  if (toolName === "generate_kie_kling_3_0_motion_control") {
    return enrichMotionControlInput(engine, input);
  }
  if (toolName === "extend_kie_grok_imagine_video") {
    return enrichGrokExtendInput(engine, input);
  }
  if (toolName === "generate_kie_happyhorse_1_1_edit_video") {
    return enrichHappyHorseVideoEditInput(engine, input);
  }
  if (toolName === "generate_kie_omnihuman_1_5_video") {
    return enrichSourceDuration(engine, input, "audio_ref", "audio");
  }
  if (toolName === "generate_kie_volcengine_video_to_video_lip_sync") {
    return enrichSourceDuration(engine, input, "video_ref", "video");
  }
  if (typeof input.book_id === "string" && Array.isArray(input.video_refs)) {
    const refs = input.video_refs.filter((ref): ref is string => typeof ref === "string");
    const duration = refs.length === input.video_refs.length
      ? await referenceVideoDuration(engine, refs)
      : undefined;
    if (duration !== undefined) return { ...input, input_video_duration: duration };
  }
  return input;
}

async function estimateOne(
  engine: Engine,
  toolName: string,
  input: Record<string, unknown>,
): Promise<CostEstimate> {
  // Google Flow: local Gemini API list USD (+ plan credits metadata).
  // @apicity/cost@0.8.0 has googleflow credit×Pro rates; we keep API list USD
  // (docs/apicity-gaps.md §15, product choice A).
  const flow = estimateGoogleFlowCost(toolName, input);
  if (flow) return flow;

  const adapter = getCostAdapter(toolName);
  if (!adapter) return unknown(toolName);
  const enriched = await enrichInput(engine, toolName, input);
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

export function estimateCostDef(engine: Engine, books?: BookManager): ToolDef {
  let injectedBookId: string | null = null;
  try {
    injectedBookId = engine.book.get().bookId;
  } catch {
    injectedBookId = null;
  }

  const estimateCall = async (call: { tool_name: string; input: Record<string, unknown> }) => {
    const bookId = call.input.book_id;
    if (typeof bookId !== "string" || !bookId || bookId === injectedBookId) {
      return estimateOne(engine, call.tool_name, call.input);
    }
    if (!books) throw new Error(`Book not found: ${bookId}`);
    const book = await books.ensure(bookId);
    if (!book.ok) throw new Error(book.error.message);
    return estimateOne(book.value.engine, call.tool_name, call.input);
  };

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
      let estimates: CostEstimate[];
      try {
        estimates = await Promise.all(calls.map(estimateCall));
      } catch (cause) {
        return {
          isError: true,
          content: [{ type: "text", text: cause instanceof Error ? cause.message : String(cause) }],
        };
      }
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
