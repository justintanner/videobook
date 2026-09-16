import type { Engine } from "videobook-engine";
import {
  assessToolCallEstimate,
  logUnavailableCostEstimate,
} from "./jobs/cost-estimate-assessment.js";
import type { PinnedChainTarget } from "./chain-plan.js";

/** Keys whose values never belong on a review sheet or in a spoken line. */
const SENSITIVE_KEY = /api.?key|secret|(?:^|[_-])token(?:$|[_-])|password|credential|authorization/iu;

export type ChainStepReview = {
  stepId: string;
  index: number;
  total: number;
  tool: string;
  title: string;
  address: string | null;
  params: Record<string, unknown>;
  estimateUsd: number | null;
  estimateUnavailable: boolean;
  estimateWarnings: string[];
  reason: string;
};

export type ChainStepReviewInput = {
  engine: Engine;
  bookId: string;
  stepId: string;
  tool: string;
  index: number;
  total: number;
  pins: readonly PinnedChainTarget[];
  dispatchParams: Record<string, unknown>;
};

function humanize(value: string): string {
  const words = value.replaceAll("_", " ").replace(/^generate kie /u, "generate ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function reviewParams(params: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(params)
      .filter(([key]) => key !== "book_id" && key !== "notebook_id")
      .map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? "Hidden" : value]),
  );
}

function formatUsd(usd: number): string {
  return usd < 0.01 ? `${Math.round(usd * 100)} cents` : `$${usd.toFixed(2)}`;
}

/** One sentence naming the step, what it consumes, and what approving costs. */
function reviewReason(input: {
  title: string;
  index: number;
  total: number;
  address: string | null;
  estimateUsd: number | null;
}): string {
  const position = `Step ${input.index + 1} of ${input.total}`;
  const source = input.address ? ` from ${input.address}` : "";
  const cost = input.estimateUsd === null
    ? "I can't price this one"
    : `about ${formatUsd(input.estimateUsd)}`;
  return `${position}: ${input.title.toLowerCase()}${source}, ${cost}. Apply to spend it, or cancel to stop the whole chain.`;
}

/**
 * Price a paused step from its dispatch-ready params. Estimating earlier would
 * price the {$ref} placeholder rather than the value the step actually receives.
 */
export async function buildChainStepReview(
  input: ChainStepReviewInput,
): Promise<ChainStepReview> {
  const assessment = await assessToolCallEstimate(
    input.engine,
    input.tool,
    input.dispatchParams,
  );
  if (!assessment.available) {
    await logUnavailableCostEstimate({
      assessment,
      engine: input.engine,
      correlation: { bookId: input.bookId, tool: input.tool, stage: "chain-step" },
    });
  }
  const estimateUsd = assessment.available ? assessment.usd : null;
  const title = humanize(input.tool);
  const address = input.pins[0]?.address ?? null;
  return {
    stepId: input.stepId,
    index: input.index,
    total: input.total,
    tool: input.tool,
    title,
    address,
    params: reviewParams(input.dispatchParams),
    estimateUsd,
    estimateUnavailable: !assessment.available,
    estimateWarnings: assessment.warnings,
    reason: reviewReason({
      title,
      index: input.index,
      total: input.total,
      address,
      estimateUsd,
    }),
  };
}
