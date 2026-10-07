import type { Engine } from "videobook-engine";
import type { GoalPlan } from "./goal-plan.js";

export type GoalRecord = {
  goalId: string;
  bookId: string;
  notebookId: string;
  requestId: string;
  brief: string;
  status: "planning" | "review" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
  revision: number;
  plan: GoalPlan | null;
  estimate: { usd: number | null; warnings: string[] };
  chainId: string | null;
  planningJobId: number | null;
  clipIds: string[];
  trackId: string | null;
  assembly: { sequenceId: string; startFrame: number; durationFrames: number } | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
};

const KEY = "application.goals.v1";

export function listGoals(engine: Engine, notebookId: string): GoalRecord[] {
  return Object.values(engine.settings.get<Record<string, GoalRecord>>(KEY) ?? {})
    .filter((goal) => goal.notebookId === notebookId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readGoal(engine: Engine, goalId: string): GoalRecord {
  const goal = engine.settings.get<Record<string, GoalRecord>>(KEY)?.[goalId];
  if (!goal || goal.bookId !== engine.book.get().bookId) throw new Error("Goal not found in this book");
  return goal;
}

export function saveGoal(engine: Engine, goal: GoalRecord): GoalRecord {
  const store = engine.settings.get<Record<string, GoalRecord>>(KEY) ?? {};
  const next = { ...goal, updatedAt: new Date().toISOString() };
  const result = engine.settings.set(KEY, { ...store, [goal.goalId]: next });
  if (!result.ok) throw new Error(result.error.message);
  return next;
}
