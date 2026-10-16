import { computeEstimate } from "@apicity/cost";
import type { MediaGenerationRequest } from "@apicity/kie";
import type { Engine } from "videobook-engine";
import { logger } from "../logger.js";
import { appendDiagnostic, diagnosticRecord, type DiagnosticFields } from "../diagnostics.js";
import { estimateCostDef } from "../tools/estimate-cost.js";

export type KieCostHints = { duration?: number; inputDuration?: number };

export function toUpstreamCostHints(hints: KieCostHints): { durationSeconds?: number; inputDurationSeconds?: number } {
  return {
    ...(typeof hints.duration === "number" && hints.duration > 0 ? { durationSeconds: hints.duration } : {}),
    ...(typeof hints.inputDuration === "number" && hints.inputDuration > 0 ? { inputDurationSeconds: hints.inputDuration } : {}),
  };
}

type CostEstimateReason =
  | "unbounded"
  | "zero"
  | "missing-adapter"
  | "missing-rates"
  | "missing-selector"
  | "estimator-threw"
  | "estimate-error";

export type CostEstimateAssessment =
  | {
      available: true;
      usd: number;
      warnings: string[];
    }
  | {
      available: false;
      usd?: number;
      warnings: string[];
      reason: CostEstimateReason;
    };

export type CostEstimateLogContext = {
  bookId?: string;
  artifactId?: string;
  runId?: string;
  jobId?: string;
  tool?: string;
  provider?: string;
  model?: string;
  stage?: string;
  notebookId?: string;
  cellId?: string;
  outputCellId?: string;
};

function assessComputedEstimate(estimate: {
  usd: number;
  warnings: readonly string[];
}): CostEstimateAssessment {
  const warnings = estimate.warnings.filter((warning) =>
    typeof warning === "string" && warning.length > 0);
  if (estimate.usd > 0) {
    return { available: true, usd: estimate.usd, warnings };
  }
  if (warnings.length === 0 && estimate.usd === 0) {
    return { available: true, usd: 0, warnings };
  }
  return {
    available: false,
    usd: estimate.usd,
    warnings,
    reason: classifyUnavailable(warnings, estimate.usd),
  };
}

export function assessBestEffortEstimate(
  compute: () => { usd: number; warnings: readonly string[] },
): CostEstimateAssessment {
  try {
    return assessComputedEstimate(compute());
  } catch {
    return {
      available: false,
      warnings: [],
      reason: "estimator-threw",
    };
  }
}

export function assessKieRequestEstimate(
  request: MediaGenerationRequest,
  costHints: KieCostHints = {},
): CostEstimateAssessment {
  return assessBestEffortEstimate(() => computeEstimate({
    provider: "kie",
    payload: request as unknown as Record<string, unknown>,
    costHints: toUpstreamCostHints(costHints),
  }));
}

export async function assessToolCallEstimate(
  engine: Engine,
  tool: string,
  input: Record<string, unknown>,
): Promise<CostEstimateAssessment> {
  try {
    const result = await estimateCostDef(engine).handler({
      calls: [{ tool_name: tool, input }],
    });
    if (result.isError) {
      return {
        available: false,
        warnings: [],
        reason: "estimate-error",
      };
    }
    const text = result.content.find((item) => item.type === "text")?.text;
    const parsed = text
      ? JSON.parse(text) as {
          estimate?: {
            usd?: unknown;
            warnings?: unknown;
          };
        }
      : {};
    const warnings = Array.isArray(parsed.estimate?.warnings)
      ? parsed.estimate.warnings.filter((warning): warning is string =>
        typeof warning === "string")
      : [];
    const usd = typeof parsed.estimate?.usd === "number"
      ? parsed.estimate.usd
      : undefined;
    if (usd === undefined) {
      return {
        available: false,
        warnings,
        reason: classifyUnavailable(warnings, usd),
      };
    }
    return assessComputedEstimate({ usd, warnings });
  } catch {
    return {
      available: false,
      warnings: [],
      reason: "estimator-threw",
    };
  }
}

export function sanitizedCostEstimateLog(input: {
  assessment: CostEstimateAssessment;
  correlation?: CostEstimateLogContext;
}): DiagnosticFields {
  return diagnosticRecord("generation-cost-estimate", {
    ...input.correlation,
    available: input.assessment.available,
    ...(input.assessment.available ? {} : { reason: input.assessment.reason }),
    warningCount: input.assessment.warnings.length,
  });
}

export async function logUnavailableCostEstimate(input: {
  assessment: CostEstimateAssessment;
  engine?: Engine;
  correlation?: CostEstimateLogContext;
}): Promise<void> {
  if (input.assessment.available) return;
  const line = sanitizedCostEstimateLog(input);
  logger.warn("generation-cost-estimate", line);
  if (!input.engine) return;
  await appendDiagnostic(input.engine, "generation-cost-estimate", line).catch(() =>
    undefined);
}

function classifyUnavailable(
  warnings: readonly string[],
  usd: number | undefined,
): CostEstimateReason {
  const text = warnings.join(" ").toLowerCase();
  if (/no cost adapter/.test(text)) return "missing-adapter";
  if (/not found in pricing table/.test(text) || /model '.+' not found/.test(text)) {
    return "missing-rates";
  }
  if (/selector|variant '/.test(text)) return "missing-selector";
  if (usd === 0) return "zero";
  return "unbounded";
}
