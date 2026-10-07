import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { firstEmptyNotebookGridSlot, notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import { goalPlanSchema, type GoalPlan } from "./goal-plan.js";
import { mutateNotebook } from "./notebook-mutations.js";

export type GoalStatus = "planning" | "review" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type GoalEstimate = { usd: number | null; warnings: string[] };

export type GoalAssembly = { sequenceId: string; startFrame: number; durationFrames: number };

export type GoalRecord = {
  goalId: string;
  bookId: string;
  notebookId: string;
  cellId: string;
  requestId: string;
  status: GoalStatus;
  chainId: string | null;
  planningJobId: number | null;
  clipIds: string[];
  trackId: string | null;
  assembly: GoalAssembly | null;
  error: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoalContent = {
  brief: string;
  revision: number;
  plan: GoalPlan | null;
  estimate: GoalEstimate;
};

const KEY = "application.goals.v1";
const GOAL_TILE_LABEL = "Video goal";
const REMOVED_TILE_ERROR = "This goal's tile was removed from the notebook";

function goalStore(engine: Engine): Record<string, GoalRecord> {
  return engine.settings.get<Record<string, GoalRecord>>(KEY) ?? {};
}

function hasTile(goal: GoalRecord): boolean {
  return typeof goal.cellId === "string";
}

export function listGoals(engine: Engine, notebookId: string): GoalRecord[] {
  return Object.values(goalStore(engine))
    .filter((goal) => goal.notebookId === notebookId && hasTile(goal))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function readGoal(engine: Engine, goalId: string): GoalRecord {
  const goal = goalStore(engine)[goalId];
  if (!goal || !hasTile(goal) || goal.bookId !== engine.book.get().bookId) throw new Error("Goal not found in this book");
  return goal;
}

export function saveGoal(engine: Engine, goal: GoalRecord): GoalRecord {
  const next = { ...goal, updatedAt: new Date().toISOString() };
  const result = engine.settings.set(KEY, { ...goalStore(engine), [goal.goalId]: next });
  if (!result.ok) throw new Error(result.error.message);
  return next;
}

function estimateFrom(value: unknown): GoalEstimate {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  return {
    usd: typeof record.usd === "number" && Number.isFinite(record.usd) ? record.usd : null,
    warnings: Array.isArray(record.warnings) ? record.warnings.filter((entry): entry is string => typeof entry === "string") : [],
  };
}

export function goalContent(cell: NotebookCell): GoalContent {
  const inputs = cell.inputs ?? {};
  const plan = goalPlanSchema.safeParse(inputs.plan);
  return {
    brief: cell.prompt ?? "",
    revision: typeof inputs.revision === "number" && Number.isInteger(inputs.revision) ? inputs.revision : 0,
    plan: plan.success ? plan.data : null,
    estimate: estimateFrom(inputs.estimate),
  };
}

function goalCellInputs(goalId: string, content: GoalContent): Record<string, unknown> {
  return { goalId, revision: content.revision, plan: content.plan, estimate: content.estimate };
}

function goalCellText(content: GoalContent): { label: string; prompt: string } {
  return { label: content.plan?.title ?? GOAL_TILE_LABEL, prompt: content.brief };
}

export function findGoalCell(document: NotebookDocument, goal: GoalRecord): NotebookCell | null {
  return document.cells.find((cell) => cell.id === goal.cellId && cell.type === "goal") ?? null;
}

export function readGoalCell(engine: Engine, goal: GoalRecord): NotebookCell | null {
  const notebook = engine.notebooks.read(goal.notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return findGoalCell(notebook.value, goal);
}

export function requireGoalContent(engine: Engine, goal: GoalRecord): GoalContent {
  const cell = readGoalCell(engine, goal);
  if (!cell) throw new Error(REMOVED_TILE_ERROR);
  return goalContent(cell);
}

export async function createGoalCell(engine: Engine, notebookId: string, goalId: string, content: GoalContent): Promise<NotebookCell> {
  const created: { cell: NotebookCell | null } = { cell: null };
  const result = await mutateNotebook(engine, notebookId, "goal_create", (document) => {
    const cell = engine.notebooks.createCell({
      type: "goal",
      ...goalCellText(content),
      slot: firstEmptyNotebookGridSlot(notebookOccupiedSlots(document.cells)),
      inputs: goalCellInputs(goalId, content),
    });
    created.cell = cell;
    return { ...document, cells: [...document.cells, cell] };
  }, { goalId });
  if (!result.ok) throw new Error(result.error.message);
  if (!created.cell) throw new Error("The goal tile could not be placed");
  return created.cell;
}

export async function writeGoalContent(engine: Engine, goal: GoalRecord, content: GoalContent): Promise<void> {
  const result = await mutateNotebook(engine, goal.notebookId, "goal_plan", (document) => {
    if (!findGoalCell(document, goal)) throw new Error(REMOVED_TILE_ERROR);
    return {
      ...document,
      cells: document.cells.map((cell) => cell.id === goal.cellId
        ? { ...cell, ...goalCellText(content), inputs: goalCellInputs(goal.goalId, content) }
        : cell),
    };
  }, { goalId: goal.goalId });
  if (!result.ok) throw new Error(result.error.message);
}
