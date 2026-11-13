import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { firstEmptyNotebookGridSlot, notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import { goalShortDraftSchema, goalShortPlanSchema, type GoalShortDraft, type GoalShortPlan } from "./goal-short-plan.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";

export type GoalStatus = "planning" | "review" | "running" | "completed" | "failed" | "cancelled" | "interrupted";
export type GoalGenerationStage = "frame" | "videos";
type StoredGoalStage = GoalGenerationStage | "storyboards";

export type GoalEstimate = { usd: number | null; warnings: string[] };
export type GoalEstimates = Record<StoredGoalStage | "total", GoalEstimate> & { segments?: GoalEstimate[] };
export type GoalStageOutput = { index: number; artifactId: string; cellId: string | null; producerCellId: string | null; address: string | null };
export type GoalStillAttempt = {
  stage: GoalGenerationStage;
  index: number;
  chainId: string;
  stepId: string;
  artifactId: string | null;
  cellId: string | null;
  basePrompt: string;
  fingerprint?: string;
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

export type GoalRealismFinding = { severity: "note" | "warn"; text: string };
export type GoalRealismCheck = {
  status: "running" | "completed" | "failed";
  checkedAt: string | null;
  findings: GoalRealismFinding[];
  error: string | null;
  jobId?: number | null;
};

export type GoalAssembly = { sequenceId: string; startFrame: number; durationFrames: number; clipSnapshot?: string; artifactIds?: string[] };
export type GoalCombinedVideo = { artifactId: string; cellId: string; jobId: number | null; status: "running" | "completed" | "failed"; error: string | null; sourceArtifactIds?: string[] };
export type GoalFinish = {
  status: "review" | "running" | "completed" | "failed" | "cancelled";
  sourceArtifactId: string;
  finalArtifactId: string | null;
  error: string | null;
  sourceObjectHash?: string | null;
  startSeconds?: number | null;
  endSeconds?: number | null;
  identity?: string | null;
  coldOpenArtifactId?: string | null;
  coldOpenRequestId?: string | null;
  jobId?: number | null;
};

export type GoalRecord = {
  planVersion: 1 | 2 | 3 | 4;
  stage: StoredGoalStage | "assembly";
  stages: Partial<Record<StoredGoalStage, GoalStageRun>>;
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
  finish?: GoalFinish | null;
  realism?: Record<string, GoalRealismCheck>;
  resumeStage?: GoalGenerationStage | null;
  resumeStatus?: "review" | "completed" | null;
  resumeOutputs?: GoalStageOutput[] | null;
  resumeFinish?: GoalFinish | null;
  error: string | null;
  dismissedAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoalShortContent = {
  brief: string;
  revision: number;
  draft: GoalShortDraft | null;
  plan: GoalShortPlan | null;
  estimate: GoalEstimates;
  notes: string[];
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
  return {
    frame: estimateFrom(record.frame), storyboards: estimateFrom(record.storyboards), videos: estimateFrom(record.videos), total: estimateFrom(record.total),
    ...(Array.isArray(record.segments) ? { segments: record.segments.map(estimateFrom) } : {}),
  };
}

export function legacyGoalText(cell: NotebookCell): { title: string | null; brief: string } {
  const plan = cell.inputs?.plan;
  const title = plan && typeof plan === "object" && typeof (plan as Record<string, unknown>).title === "string" ? (plan as { title: string }).title : null;
  return { title, brief: cell.prompt ?? "" };
}

export function findGoalCell(document: NotebookDocument, goal: GoalRecord): NotebookCell | null {
  return document.cells.find((cell) => cell.id === goal.cellId && cell.type === "goal") ?? null;
}

export function readGoalCell(engine: Engine, goal: GoalRecord): NotebookCell | null {
  const notebook = engine.notebooks.read(goal.notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return findGoalCell(notebook.value, goal);
}

function notesFrom(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}

export function goalShortContent(cell: NotebookCell): GoalShortContent {
  const inputs = cell.inputs ?? {};
  const draft = goalShortDraftSchema.safeParse(inputs.draft);
  const plan = goalShortPlanSchema.safeParse(inputs.plan);
  return {
    brief: cell.prompt ?? "",
    revision: typeof inputs.revision === "number" && Number.isInteger(inputs.revision) ? inputs.revision : 0,
    draft: draft.success ? draft.data : null,
    plan: plan.success ? plan.data : null,
    estimate: estimatesFrom(inputs.estimate),
    notes: notesFrom(inputs.notes),
  };
}

export function requireGoalShortContent(engine: Engine, goal: GoalRecord): GoalShortContent {
  const cell = readGoalCell(engine, goal);
  if (!cell) throw new Error(REMOVED_TILE_ERROR);
  return goalShortContent(cell);
}

type GoalTileSource = { cellId: string; targetInput: string };

async function placeGoalTile(engine: Engine, notebookId: string, goalId: string, text: { label: string; prompt: string }, inputs: Record<string, unknown>, sources: readonly GoalTileSource[]): Promise<NotebookCell> {
  const created: { cell: NotebookCell | null } = { cell: null };
  const result = await mutateNotebook(engine, notebookId, "goal_create", (document) => {
    const cell = engine.notebooks.createCell({
      type: "goal",
      ...text,
      slot: firstEmptyNotebookGridSlot(notebookOccupiedSlots(document.cells)),
      inputs,
    });
    created.cell = cell;
    const edges = sources.map((source) => engine.notebooks.createEdge({ source: source.cellId, target: cell.id, targetInput: source.targetInput }));
    const arranged = arrangeGoalNotebook({ ...document, cells: [...document.cells, cell], edges: [...document.edges, ...edges] });
    created.cell = arranged.cells.find(candidate => candidate.id === cell.id)!;
    return arranged;
  }, { goalId });
  if (!result.ok) throw new Error(result.error.message);
  if (!created.cell) throw new Error("The goal tile could not be placed");
  return created.cell;
}

function shortTileText(content: GoalShortContent): { label: string; prompt: string } {
  return { label: content.plan?.title ?? GOAL_TILE_LABEL, prompt: content.brief };
}

function shortTileInputs(goalId: string, content: GoalShortContent): Record<string, unknown> {
  return { goalId, revision: content.revision, plan: content.plan, draft: content.draft, estimate: content.estimate, notes: content.notes };
}

function shortTileSources(content: GoalShortContent): GoalTileSource[] {
  const characters = content.plan?.character.references ?? content.draft?.character.references ?? [];
  return characters.map((reference, index) => ({ cellId: reference.cellId, targetInput: index === 0 ? "character" : `character_${index + 1}` }));
}

export async function createGoalShortCell(engine: Engine, notebookId: string, goalId: string, content: GoalShortContent): Promise<NotebookCell> {
  return placeGoalTile(engine, notebookId, goalId, shortTileText(content), shortTileInputs(goalId, content), shortTileSources(content));
}

async function writeGoalTile(engine: Engine, goal: GoalRecord, text: { label: string; prompt: string }, inputs: Record<string, unknown>): Promise<void> {
  const result = await mutateNotebook(engine, goal.notebookId, "goal_plan", (document) => {
    if (!findGoalCell(document, goal)) throw new Error(REMOVED_TILE_ERROR);
    return {
      ...document,
      cells: document.cells.map((cell) => cell.id === goal.cellId ? { ...cell, ...text, inputs } : cell),
    };
  }, { goalId: goal.goalId });
  if (!result.ok) throw new Error(result.error.message);
}

export async function writeGoalShortContent(engine: Engine, goal: GoalRecord, content: GoalShortContent): Promise<void> {
  await writeGoalTile(engine, goal, shortTileText(content), shortTileInputs(goal.goalId, content));
}
