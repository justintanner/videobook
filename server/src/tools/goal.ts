import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { cancelChainRun } from "../chain-executor.js";
import { goalShortPlanSchema, SHORT_STORYBOARD_MODELS, shortPlanTitleInput } from "../goal-short-plan.js";
import { createShortGoal, queueShortRealismCheck, reanalyzeShortGoal, retryShortGoal, saveShortDefaults, selectShortVersion, shortFeedbackSchema, startShortStage, updateShortGoal } from "../goal-short-runtime.js";
import { LEGACY_GOAL_MESSAGE, publicGoal, reconcileFinish, reconcileGoal } from "../goal-state.js";
import { activeGoalStage, findGoalCell, isCurrentShort, listGoals, readGoal, readGoalCell, saveGoal, type GoalRecord } from "../goal-store.js";
import { requestGoalTitles, type GoalTitleOptions } from "../graphics/suggest.js";
import { queueGoalFinish } from "../jobs/finish-goal.js";
import { goalPreparationInputSchema, prepareShortSource, reviewShortSource } from "../goal-source-preparation.js";
import { reviewShortAction } from "../goal-remix-assembly.js";
import { refreshShortFinishSettings } from "../goal-finish-settings.js";
import { queueGoalOutputCheck } from "../goal-quality.js";
import { pauseGoalAutomation, startGoalAutomation } from "../goal-automation.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import type { ToolDef, ToolResult } from "./tool-def.js";
import { advertisedAs } from "./tool-json-schema.js";

const json = (value: unknown): ToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const errorMessage = (error: unknown): string => error instanceof Error ? error.message : String(error);
const failure = (error: unknown): ToolResult => ({ isError: true, content: [{ type: "text", text: errorMessage(error) }] });
const ACTIVE_STATUSES = new Set(["planning", "review", "running"]);
const LEGACY_ACTIONS = new Set(["status", "cancel", "dismiss"]);
type GoalArgs = Record<string, unknown>;
const stageSchema = z.enum(["storyboards", "replacement", "frame", "videos", "finish"]);
export type GoalSnapshot = Awaited<ReturnType<typeof publicGoal>>;
export type ShortGoalSnapshot = Extract<GoalSnapshot, { legacy: false }>;
export type LegacyGoalSnapshot = Extract<GoalSnapshot, { legacy: true }>;

function readNotebook(engine: Engine, notebookId: string): NotebookDocument {
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return notebook.value;
}

async function goalSnapshot(engine: Engine, goal: GoalRecord): Promise<GoalSnapshot> {
  const finished = reconcileFinish(engine, goal);
  const current = await reconcileGoal(engine, finished, readNotebook(engine, finished.notebookId));
  return publicGoal(engine, current, readNotebook(engine, finished.notebookId));
}

async function createGoal(engine: Engine, bookId: string, notebookId: string, args: GoalArgs): Promise<GoalSnapshot> {
  return withNotebookMutation(`goal-create:${bookId}`, async () => {
    const brief = z.string().trim().min(1).max(6000).parse(args.brief);
    const requestId = typeof args.request_id === "string" ? args.request_id : uuidv7();
    const existing = listGoals(engine, notebookId).find(goal => goal.requestId === requestId);
    if (existing) {
      const cell = readGoalCell(engine, existing);
      if (cell && (cell.prompt ?? "") !== brief) throw new Error("This request_id already belongs to a different goal");
      return goalSnapshot(engine, existing);
    }
    const plan = args.plan === undefined ? undefined : goalShortPlanSchema.parse(args.plan);
    return goalSnapshot(engine, await createShortGoal(engine, bookId, notebookId, { brief, requestId, ...(plan ? { plan } : {}) }));
  });
}

function stopStillRun(engine: Engine, goal: GoalRecord): GoalRecord | null {
  const stage = activeGoalStage(goal);
  const run = goal.stages[stage];
  const previousChainId = run?.previousChainIds.at(-1);
  if (goal.status !== "running" || !goal.resumeStage || !run || !previousChainId || !goal.chainId) return null;
  cancelChainRun(engine, goal.chainId);
  const finish = goal.resumeFinish === undefined ? goal.finish : goal.resumeFinish;
  return saveGoal(engine, {
    ...goal, status: goal.resumeStatus ?? "review", stage: goal.resumeStage, chainId: previousChainId, error: null, resumeStage: null, resumeStatus: null, resumeOutputs: null,
    ...(goal.resumeFinish !== undefined ? { resumeFinish: null, finish } : {}),
    stages: { ...goal.stages, [stage]: {
      ...run, outputs: goal.resumeOutputs ?? run.outputs, chainId: previousChainId, previousChainIds: [...run.previousChainIds.slice(0, -1), ...(run.chainId ? [run.chainId] : [])],
    } },
  });
}

async function cancelGoal(engine: Engine, goal: GoalRecord, options: { discard?: boolean } = {}): Promise<GoalRecord> {
  goal = pauseGoalAutomation(engine, goal, "Automatic continuation was cancelled.");
  const checking = Object.entries(goal.quality ?? {}).filter(([, check]) => check.status === "running");
  if (checking.length) {
    for (const [, check] of checking) if (check.jobId) await engine.jobs.queue.abort(check.jobId, "Output check cancelled");
    goal = saveGoal(engine, { ...goal, quality: { ...goal.quality, ...Object.fromEntries(checking.map(([slot, check]) => [slot, { ...check, status: "failed", error: "Output check cancelled" }])) } });
  }
  if (isCurrentShort(goal.planVersion) && goal.finish?.status === "running") {
    if (goal.finish.jobId) await engine.jobs.queue.abort(goal.finish.jobId, "Finishing cancelled");
    return saveGoal(engine, { ...goal, status: "review", error: null, finish: { ...goal.finish, status: "cancelled", error: null } });
  }
  if (!ACTIVE_STATUSES.has(goal.status)) return goal;
  const resumed = options.discard || !isCurrentShort(goal.planVersion) ? null : stopStillRun(engine, goal);
  if (resumed) return resumed;
  const cancelled = saveGoal(engine, { ...goal, status: "cancelled", error: null,
    ...(goal.preparation?.status === "running" ? { preparation: { ...goal.preparation, status: "failed", error: "Preparation cancelled" } } : {}) });
  if (cancelled.chainId) cancelChainRun(engine, cancelled.chainId);
  if (cancelled.planningJobId) await engine.jobs.queue.abort(cancelled.planningJobId, "Goal cancelled");
  return cancelled;
}

async function applyGoalAction(engine: Engine, notebookId: string, goalId: string, args: GoalArgs): Promise<GoalRecord> {
  const stored = readGoal(engine, goalId);
  if (stored.notebookId !== notebookId) throw new Error("Goal does not belong to this notebook");
  let goal = await reconcileGoal(engine, reconcileFinish(engine, stored), readNotebook(engine, notebookId));
  if (!isCurrentShort(goal.planVersion) && !LEGACY_ACTIONS.has(String(args.action))) throw new Error(LEGACY_GOAL_MESSAGE);
  if (args.action === "auto_continue") return startGoalAutomation(engine, goal, args);
  if (args.action === "pause_auto") return pauseGoalAutomation(engine, goal);
  if (goal.automation?.status === "running" && ["update", "analyze", "refresh_finish", "prepare", "select", "adopt", "approve", "regenerate", "revise", "retry", "finish"].includes(String(args.action))) {
    goal = pauseGoalAutomation(engine, goal, "A manual change paused automatic continuation. Review the saved recipe before resuming.");
  }
  if (args.action === "update") return updateShortGoal(engine, goal, args);
  if (args.action === "analyze") return reanalyzeShortGoal(engine, goal, args.revision);
  if (args.action === "save_defaults") return saveShortDefaults(engine, goal, args.revision);
  if (args.action === "refresh_finish") return refreshShortFinishSettings(engine, goal, args);
  if (args.action === "prepare") return prepareShortSource(engine, goal, args.revision, args.preparation);
  if (args.action === "review_source") return reviewShortSource(engine, goal, args);
  if (args.action === "review_action") return reviewShortAction(engine, goal, args);
  if (args.action === "select" || args.action === "adopt") return selectShortVersion(engine, goal, args);
  if (args.action === "approve" || args.action === "regenerate" || args.action === "revise") return startShortStage(engine, goal, args, args.action !== "approve");
  if (args.action === "cancel") return cancelGoal(engine, goal);
  if (args.action === "finish") return queueGoalFinish(engine, goal);
  if (args.action === "retry") return retryShortGoal(engine, goal);
  if (args.action === "check") return queueShortRealismCheck(engine, goal, args);
  if (args.action === "check_output") return queueGoalOutputCheck(engine, goal, args);
  if (args.action === "dismiss") {
    if (ACTIVE_STATUSES.has(goal.status)) throw new Error("Stop the goal before dismissing it");
    return saveGoal(engine, { ...goal, dismissedAt: new Date().toISOString() });
  }
  return goal;
}

async function writeGoalTitles(engine: Engine, bookId: string, notebookId: string, goalId: string): Promise<GoalTitleOptions> {
  if (readGoal(engine, goalId).notebookId !== notebookId) throw new Error("Goal does not belong to this notebook");
  try {
    return await requestGoalTitles(engine, bookId, goalId);
  } catch (error) {
    const message = errorMessage(error);
    if (/^Job \d+ timed out/u.test(message)) throw new Error("Writing the title took too long. Write title again, or type the title.");
    throw new Error(message.replace(/^Job \d+ (?:failed|aborted): /u, ""));
  }
}

async function listGoalSnapshots(engine: Engine, notebook: NotebookDocument): Promise<GoalSnapshot[]> {
  const snapshots: GoalSnapshot[] = [];
  for (const goal of listGoals(engine, notebook.id)) {
    await withNotebookMutation(`goal:${goal.goalId}`, async () => {
      if (findGoalCell(notebook, goal)) snapshots.push(await goalSnapshot(engine, readGoal(engine, goal.goalId)));
      else await cancelGoal(engine, readGoal(engine, goal.goalId), { discard: true });
    });
  }
  return snapshots;
}

export function goalDefs(engine: Engine): ToolDef[] {
  return [{
    name: "video_goal", scope: "book",
    description: "Run Goal mode on a notebook. create makes a 5-60 second short (12 by default). Mention images for identity and the first video as the source. Initial queued analysis reuses current source metadata, scenes and sampled observations, resolves the brief against book defaults, chooses an action-relevant source frame, and records timing, reference requirements, graphics removal, sound, branding, costs and unresolved decisions before generation. An explicit @a1 at 3s pins the source frame. The editable shortPlan.analysis contains the resolved recipe; explicit instructions override defaults. Source remixes can insert or replace a person and preserve source shots. Authored replace/frame/video or numbered beat prompts skip paid prompt writing but still receive initial preflight. analyze refreshes source evidence using caches and retains authored prompts; save_defaults explicitly saves the current effective choices for future goals in this book. prepare executes confirmed removal regions locally or adopts an existing cleaned artifact with matching source, masks, method and media hash. It validates duration, geometry, decoding and source audio, then binds the still and bounded video reference to that copy. review_source confirms the actual prepared media hash after visual and sound review; matching reviewed copies are reused. Changed inputs require preparation again. update saves edited prompts, analysis choices or finish.title. Each paid stage remains reviewable: approve, regenerate, select or revise by stage/index. Approving an image stage reuses a compatible previously reviewed image when its prompt, settings and input hashes match. generationHistory joins chain attempts, manual reruns and related goals with actual prompts, references, models, outcomes and cost links. Manual reruns retain their originating intent revision and never change selection automatically. adopt selects a reviewed candidate using stage, index, artifact_id, current media_hash, revision and confirmed=true; it preserves the original request and records approval for the current brief. Cancelled goals remain cancelled; adopt their usable output into an active goal. revise rewrites the prompt from feedback before generation. Replacement and action references use GPT Image 2.6; video uses H3 Max, with Extend for subsequent beats. Saved storyboard plans keep their existing cleanup workflow. check preserves the earlier AI-tells review. New analyzed goals automatically run local file checks. check_output with stage replacement, frame, videos or finish and the current revision checks decoding, timing, input freshness and final assembly/audio separately from brief compliance. semantic=true explicitly requests a paid sampled identity/overlay/action review; its complete image-input price is unknown. Unchanged media and constraints reuse the saved result without another paid submission; refusal and uncertainty remain unverified. Initial analysis saves action and shot-cut sample times. title returns three optional burned-title choices without saving them. Preserved-source plans generate only the saved changed interval; edit analysis.intent.actionDescription for its local action prompt. review_action pins the selected take, media_hash and start_seconds after reviewing the complete payoff. finish assembles kept source frames with that reviewed window and renders the frozen sound, branding and optional title from initial analysis. Source audio keeps its timeline, trims or pads to the final duration, and mutes generated sound unless mix is chosen. refresh_finish adopts current book branding without source reanalysis; audio_artifact_id and audio_start_seconds can choose or refresh a separate soundtrack without regenerating video. Sound or branding edits invalidate only finish work. Failed finishes expose workingArtifactId and phase for recovery. auto_continue with confirmed=true, current revision and allowance_usd approves the saved recipe and selected images, then advances eligible steps through a durable queue checkpoint to the final preview. pause_auto stops future submissions. New images stop for review by default; source/action reviews, failed or unverified checks, changed inputs, unknown or lower-bound prices, unsettled costs, account errors and insufficient allowance pause the run. H3 lower-bound pricing currently requires explicit manual video approval. Spent, reserved and remaining values survive reload; an estimate-based allowance is not a provider billing cap. reviewed_images and reviewed_audio pin approved selections with artifact_id and media_hash; audio receipts confirm listening for no new dialogue; account_reviewed=true confirms resolving an earlier account failure. No automatic creative retries, paid title suggestions, visual checks or publication. Saved defaults never start spending by themselves. The endpoint is a final preview, never publication. list, status, cancel, retry and dismiss manage existing goals. Saved v4/v5 goals retain their stored settings until explicitly edited or reanalyzed; earlier legacy goals are read-only.",
    schema: {
      book_id: z.string().uuid(), notebook_id: z.string().uuid(),
      action: z.enum(["create", "list", "status", "update", "analyze", "save_defaults", "refresh_finish", "prepare", "review_source", "review_action", "approve", "regenerate", "select", "adopt", "revise", "cancel", "retry", "dismiss", "finish", "check", "check_output", "title", "auto_continue", "pause_auto"]),
      goal_id: z.string().uuid().optional(), request_id: z.string().min(1).max(200).optional(),
      brief: z.string().trim().min(1).max(6000).optional(), plan: advertisedAs(z.preprocess(shortPlanTitleInput, goalShortPlanSchema), {
        type: "object",
        description: "A short's plan, usually the shortPlan from a video_goal status result with fields edited in place",
      }).optional(),
      revision: z.number().int().nonnegative().optional(),
      allowance_usd: z.number().nonnegative().optional().describe("auto_continue: explicit total USD allowance across this goal's automatic reservations, including earlier automatic spend. Estimates are not a provider-enforced billing cap; unknown or incomplete prices pause the run."),
      reviewed_images: z.array(z.object({ artifact_id: z.string().uuid(), media_hash: z.string().min(1) }).strict()).optional().describe("auto_continue: hash-pinned selected images reviewed for the current brief"),
      reviewed_audio: z.array(z.object({ artifact_id: z.string().uuid(), media_hash: z.string().min(1) }).strict()).optional().describe("auto_continue: hash-pinned selected videos listened to and confirmed to contain no new dialogue"),
      account_reviewed: z.literal(true).optional().describe("auto_continue: confirm an earlier account or balance failure was resolved; this is not a live balance guarantee"),
      semantic: z.boolean().optional().describe("check_output: explicitly authorize one paid sampled review against the brief; total image-input pricing is unknown. Default false runs only free local media checks. Results are reused for unchanged media and constraints."),
      audio_artifact_id: z.string().uuid().nullable().optional().describe("refresh_finish: choose or refresh an audio/video soundtrack; null restores the original source soundtrack without changing visual generation"),
      audio_start_seconds: z.number().nonnegative().optional().describe("refresh_finish: soundtrack start mapped to final video time zero; audio is trimmed or padded to the final duration"),
      preparation: goalPreparationInputSchema.optional().describe("prepare: confirm reviewed removal regions and method; optionally adopt a cleaned artifactId with its mediaHash and matching cleanup provenance"),
      confirmed: z.literal(true).optional().describe("review_source: confirm prepared-media review; review_action: confirm the whole action and payoff; adopt: confirm this take was reviewed for the current brief; auto_continue: approve the current recipe and selected images"),
      media_hash: z.string().min(1).optional().describe("The current media hash being reviewed by review_source, review_action or adopt"),
      start_seconds: z.number().nonnegative().optional().describe("review_action: start of the retained window in the selected generated clip; aligned to source frames, with length fixed by the saved assembly recipe"),
      stage: stageSchema.optional(), index: z.number().int().min(0).max(15).optional(), artifact_id: z.string().uuid().optional(),
      feedback: shortFeedbackSchema.optional().describe("revise: what to change, written into the frame prompt or the beat before the paid step. An @ mention is rewritten to the cell's label"),
      model: z.enum(SHORT_STORYBOARD_MODELS).optional().describe("regenerate or revise one storyboard frame: the clean-up model, the storyboard's own or its other one (Seedream 5.5 Edit on Kie or Nano Banana 2.1 Edit on fal); omitted uses the storyboard's own"),
    },
    handler: async args => {
      try {
        const bookId = engine.book.get().bookId;
        if (args.book_id !== bookId) throw new Error("Goal book does not match the active book");
        const notebookId = String(args.notebook_id);
        const notebook = readNotebook(engine, notebookId);
        if (args.action === "list") return json({ goals: await listGoalSnapshots(engine, notebook) });
        if (args.action === "create") return json(await createGoal(engine, bookId, notebookId, args));
        if (args.action === "character") throw new Error("Unknown action: character");
        const goalId = z.string().uuid().parse(args.goal_id);
        if (args.action === "title") return json(await writeGoalTitles(engine, bookId, notebookId, goalId));
        return await withNotebookMutation(`goal:${goalId}`, async () => json(await goalSnapshot(engine, await applyGoalAction(engine, notebookId, goalId, args))));
      } catch (error) { return failure(error); }
    },
  }];
}
