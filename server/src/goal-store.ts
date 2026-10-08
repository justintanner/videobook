import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { firstEmptyNotebookGridSlot, notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import { goalPlanSchema, goalStyleSchema, legacyGoalPlanSchema, type GoalCharacter, type GoalDisplayPlan, type GoalStage, type GoalGenerationStage, type GoalStillStage } from "./goal-plan.js";
import type { GoalStyleSelection } from "./goal-styles.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";

export type GoalStatus = "planning" | "review" | "running" | "completed" | "failed" | "cancelled" | "interrupted";

export type GoalEstimate = { usd: number | null; warnings: string[] };
export type GoalEstimates = Record<GoalGenerationStage | "total", GoalEstimate>;
export type GoalStageOutput = { index: number; artifactId: string; cellId: string | null; producerCellId: string | null; address: string | null };
export type GoalStillAttempt = {
  stage: GoalStillStage;
  index: number;
  chainId: string;
  stepId: string;
  artifactId: string | null;
  cellId: string | null;
  basePrompt: string;
  storyboardLayout?: "four-panel";
  feedback: string | null;
  parentArtifactId: string | null;
  frameArtifactId: string | null;
  createdAt: string;
};
export type GoalStageRun = {
  chainId: string;
  revision: number;
  approvedAt: string;
  shotIndexes: number[];
  outputs: GoalStageOutput[];
  previousChainIds: string[];
  attempts?: GoalStillAttempt[];
};

export type GoalAssembly = { sequenceId: string; startFrame: number; durationFrames: number };
export type GoalCombinedVideo = { artifactId: string; cellId: string; jobId: number | null; status: "running" | "completed" | "failed"; error: string | null };

export type GoalRecord = {
  planVersion: 1 | 2;
  stage: GoalStage;
  stages: Partial<Record<GoalGenerationStage, GoalStageRun>>;
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
  combined?: GoalCombinedVideo;
  resumeStage?: GoalStage | null;
  error: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoalContent = {
  brief: string;
  characters: GoalCharacter[];
  revision: number;
  plan: GoalDisplayPlan | null;
  requestedStyle?: GoalStyleSelection;
  estimate: GoalEstimates;
};

const KEY = "application.goals.v2";
const LEGACY_KEY = "application.goals.v1";
const GOAL_TILE_LABEL = "Video goal";
const REMOVED_TILE_ERROR = "This goal's tile was removed from the notebook";

function goalStore(engine: Engine): Record<string, GoalRecord> {
  const legacy = engine.settings.get<Record<string, GoalRecord>>(LEGACY_KEY) ?? {};
  return {
    ...Object.fromEntries(Object.entries(legacy).map(([id, goal]) => [id, { ...goal, planVersion: 1 as const, stage: "videos" as const, stages: {} }])),
    ...(engine.settings.get<Record<string, GoalRecord>>(KEY) ?? {}),
  };
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
  const result = engine.settings.set(KEY, { ...(engine.settings.get<Record<string, GoalRecord>>(KEY) ?? {}), [goal.goalId]: next });
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

export function emptyGoalEstimates(): GoalEstimates {
  return { frame: { usd: null, warnings: [] }, storyboards: { usd: null, warnings: [] }, videos: { usd: null, warnings: [] }, total: { usd: null, warnings: [] } };
}

function estimatesFrom(value: unknown): GoalEstimates {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (!("total" in record)) return { ...emptyGoalEstimates(), videos: estimateFrom(value), total: estimateFrom(value) };
  return { frame: estimateFrom(record.frame), storyboards: estimateFrom(record.storyboards), videos: estimateFrom(record.videos), total: estimateFrom(record.total) };
}

function charactersFrom(value: unknown): GoalCharacter[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is GoalCharacter => entry && typeof entry === "object"
    && ["artifactId", "cellId", "address", "label"].every(key => typeof (entry as Record<string, unknown>)[key] === "string"));
}

export function goalContent(cell: NotebookCell): GoalContent {
  const inputs = cell.inputs ?? {};
  const plan = goalPlanSchema.or(legacyGoalPlanSchema).safeParse(inputs.plan);
  const requestedStyle = goalStyleSchema.safeParse(inputs.requestedStyle);
  return {
    brief: cell.prompt ?? "",
    characters: charactersFrom(inputs.characters),
    revision: typeof inputs.revision === "number" && Number.isInteger(inputs.revision) ? inputs.revision : 0,
    plan: plan.success ? plan.data : null,
    ...(!plan.success && requestedStyle.success ? { requestedStyle: requestedStyle.data } : {}),
    estimate: estimatesFrom(inputs.estimate),
  };
}

function goalCellInputs(goalId: string, content: GoalContent): Record<string, unknown> {
  return { goalId, revision: content.revision, plan: content.plan, characters: content.characters, estimate: content.estimate,
    ...(!content.plan && content.requestedStyle ? { requestedStyle: content.requestedStyle } : {}),
  };
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
    const edges = content.characters.map((character, index) => engine.notebooks.createEdge({
      source: character.cellId, target: cell.id, targetInput: index === 0 ? "character" : `character_${index + 1}`,
    }));
    const arranged = arrangeGoalNotebook({ ...document, cells: [...document.cells, cell], edges: [...document.edges, ...edges] });
    created.cell = arranged.cells.find(candidate => candidate.id === cell.id)!;
    return arranged;
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
