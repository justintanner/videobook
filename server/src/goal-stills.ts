import type { GoalGenerationStage, GoalRecord, GoalStillAttempt } from "./goal-store.js";

export function goalStageAttempts(goal: GoalRecord, stage: GoalGenerationStage): GoalStillAttempt[] {
  return [...(goal.stages[stage]?.attempts ?? [])];
}
