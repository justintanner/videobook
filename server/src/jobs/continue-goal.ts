import type { Engine } from "videobook-engine";
import { runGoalContinuation } from "../goal-automation.js";
import { registerJobHandler } from "../queue.js";

export function registerContinueGoalJob(engine: Engine): void {
  registerJobHandler("continue_goal", async (payload, context) => {
    context.signal.throwIfAborted();
    await runGoalContinuation(engine, payload as { goalId: string; automationId: string; planKey: string }, context.jobId);
    return { success: true };
  });
}
