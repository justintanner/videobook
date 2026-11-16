import { chatIntelligenceRequestOptions } from "./chat-models.js";
import { forecastLanguageCall } from "./cost.js";
import { shortPlannerNeeded } from "./goal-short-planner.js";
import { shortRemixSourceOf, type GoalShortPlan } from "./goal-short-plan.js";
import type { GoalEstimate } from "./goal-store.js";

export function goalPlanningOutputTokens(source: boolean): number { return source ? 6000 : 2000; }

export function goalPlanningEstimate(brief: string, plan: GoalShortPlan): GoalEstimate {
  const source = Boolean(shortRemixSourceOf(plan));
  if (!shortPlannerNeeded(brief, plan.segments.map(segment => segment.seconds), source)) return { usd: 0, warnings: ["Authored prompts use local initial analysis without paid prompt writing."] };
  const ceiling = goalPlanningOutputTokens(source);
  const quote = forecastLanguageCall(chatIntelligenceRequestOptions().model, brief, ceiling);
  return { usd: null, warnings: [`Initial prompt writing uses one request, up to ${ceiling} output tokens. Complete input pricing is unknown; it includes instructions and any reference images or source samples. No automatic paid corrective request.`,
    ...(quote.status === "unavailable" ? quote.warnings : [`Brief/output portion estimated at $${quote.usd.toFixed(4)}; other input is additional.`])] };
}
