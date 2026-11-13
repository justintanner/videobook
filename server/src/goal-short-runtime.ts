import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile, resolveNotebookCellArtifactId } from "videobook-engine";
import { firstEmptyNotebookGridSlot, notebookGridTag, notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import { scanNotebookMentions, type NotebookMention } from "videobook-engine/notebook-mentions";
import { getApiKey } from "./api-key.js";
import { getChainRun, preflightAndAccept, retryChainRun } from "./chain-executor.js";
import type { ChainStep } from "./chain-plan.js";
import { probeVideo } from "./ffmpeg.js";
import { reconcileMainCharacter } from "./goal-short-character.js";
import {
  buildGoalShortPlan, compileShortClipStep, compileShortContinuationStep, compileShortFrameStep, goalShortPlanSchema, refreshGoalShortPlan,
  shortTiming, withShortCharacterReferences, type GoalShortDraft, type GoalShortImageRef, type GoalShortPlan,
} from "./goal-short-plan.js";
import { shortAuthoredCopy, shortPlannerNeeded, shortTitle } from "./goal-short-planner.js";
import { renderReferenceNotes, usableImageReference, type ReferenceNote } from "./goal-short-references.js";
import { goalReferenceHashes } from "./goal-reference-images.js";
import { goalStageAttempts } from "./goal-stills.js";
import {
  createGoalShortCell, emptyGoalEstimates, readGoal, requireGoalShortContent, saveGoal, writeGoalShortContent,
  type GoalEstimate, type GoalEstimates, type GoalRecord, type GoalShortContent, type GoalStageOutput,
} from "./goal-store.js";
import { assessToolCallEstimate } from "./jobs/cost-estimate-assessment.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { queue } from "./queue.js";

type GoalArgs = Record<string, unknown>;
type ShortStage = "frame" | "videos";
type ShortReference = Omit<GoalShortImageRef, "slot">;

const EXTRA_REFERENCE_LIMIT = 12;
const NO_CHARACTER_REFERENCE = "Give the main character a reference image first: generate a character sheet or choose image cells.";
const NO_FAL_KEY = "Set FAL_API_KEY in Settings before generating this stage";
const NO_OPENAI_KEY = "Set OPENAI_API_KEY in Settings to revise with feedback, or edit the prompt and regenerate.";
const REVISE_TIMEOUT_MS = 240_000;
const SETTINGS_LOCKED = "Models, resolution, aspect ratio and rules stay with this short once its frame exists. Start a new /goal to change them.";
const REFERENCES_LOCKED = "The character and references stay with this short. Start a new /goal to change them.";
const SEGMENT_LOCKED = "A generated segment keeps its place and seconds. Regenerate it, or start a new /goal to change them.";
const STALE_RETRY = "The references or selected versions changed after this attempt. Regenerate using the current selection instead of retrying the older request.";
const EXTEND_SOURCE_SECONDS = { minimum: 1.625, maximum: 60 };
const PLACEHOLDER_FRAME = "https://videobook.invalid/short-frame.jpg";
const PLACEHOLDER_CLIP = "https://videobook.invalid/short-clip.mp4";
const stageSchema = z.enum(["frame", "videos"]);
const feedbackSchema = z.string().trim().min(1).max(300).regex(/^[^@]*$/u, "Use plain text without @ references in revision feedback");

function readNotebook(engine: Engine, notebookId: string): NotebookDocument {
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return notebook.value;
}

function cellHolding(document: NotebookDocument, artifactId: string): NotebookCell | undefined {
  return document.cells.find((cell) => cell.outputArtifactId === artifactId);
}

async function imageReference(engine: Engine, artifactId: string, cell: NotebookCell): Promise<ShortReference> {
  const address = notebookGridTag(cell.slot);
  const manifest = await engine.files.manifest(artifactId);
  const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, "image") : null;
  if (!file) throw new Error(`${address} has no readable image`);
  const artifact = engine.artifacts.get(artifactId);
  return { kind: "image", artifactId, cellId: cell.id, address, label: (artifact.ok && artifact.value.label) || cell.label || address, objectHash: file.objectHash };
}

async function characterReferences(engine: Engine, notebookId: string, artifactIds: readonly string[]): Promise<ShortReference[]> {
  if (artifactIds.some((artifactId) => !cellHolding(readNotebook(engine, notebookId), artifactId))) {
    const placed = await mutateNotebook(engine, notebookId, "goal_character_references", (document) => {
      const cells = [...document.cells];
      for (const artifactId of artifactIds) {
        if (cellHolding({ ...document, cells }, artifactId)) continue;
        const artifact = engine.artifacts.get(artifactId);
        cells.push(engine.notebooks.createCell({
          type: "image",
          label: (artifact.ok && artifact.value.label) || "Main character",
          slot: firstEmptyNotebookGridSlot(notebookOccupiedSlots(cells)),
          outputArtifactId: artifactId,
        }));
      }
      return arrangeGoalNotebook({ ...document, cells });
    });
    if (!placed.ok) throw new Error(placed.error.message);
  }
  const document = readNotebook(engine, notebookId);
  return Promise.all(artifactIds.map((artifactId) => imageReference(engine, artifactId, cellHolding(document, artifactId)!)));
}

function mentionTimestamp(brief: string, mention: NotebookMention): number | null {
  const match = /^\s+at\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/iu.exec(brief.slice(mention.end));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

async function briefReferences(engine: Engine, notebookId: string, brief: string, characterIds: ReadonlySet<string>): Promise<{ references: ShortReference[]; notes: ReferenceNote[] }> {
  const references: ShortReference[] = [];
  const notes: ReferenceNote[] = [];
  const ignored = new Set(characterIds);
  const seen = new Set<string>();
  for (const mention of scanNotebookMentions(brief)) {
    if (seen.has(mention.reference)) continue;
    seen.add(mention.reference);
    const result = await usableImageReference(engine, notebookId, mention.reference, {
      accept: references.length < EXTRA_REFERENCE_LIMIT,
      atSeconds: mentionTimestamp(brief, mention),
      ignoreArtifactIds: ignored,
      mention: mention.raw,
    });
    if (result.ignored) continue;
    if (result.sourceArtifactId && (result.image || result.countable)) ignored.add(result.sourceArtifactId);
    if (result.image) ignored.add(result.image.artifactId);
    if (!result.image) {
      if (result.countable) notes.push({ kind: "text", text: `${mention.raw} was skipped because a short takes at most ${EXTRA_REFERENCE_LIMIT} mentioned images.` });
      else if (result.note) notes.push({ kind: "text", text: result.note });
      continue;
    }
    references.push(result.image);
    if (result.frame) notes.push({ kind: "frame", mention: mention.raw, cellId: result.frame.cellId, atSeconds: result.frame.atSeconds });
  }
  return { references, notes };
}

async function priced(engine: Engine, step: ChainStep, refs: Record<string, string[]>): Promise<GoalEstimate> {
  const estimate = await assessToolCallEstimate(engine, step.tool, { book_id: engine.book.get().bookId, ...step.params, refs });
  return { usd: estimate.available ? estimate.usd : null, warnings: estimate.warnings };
}

function summed(parts: readonly GoalEstimate[]): GoalEstimate {
  return {
    usd: parts.every((part) => part.usd !== null) ? parts.reduce((sum, part) => sum + (part.usd ?? 0), 0) : null,
    warnings: [...new Set(parts.flatMap((part) => part.warnings))],
  };
}

export async function estimateShort(engine: Engine, plan: GoalShortPlan): Promise<GoalEstimates> {
  const characters = plan.character.references.map((reference) => reference.artifactId);
  const images = [...characters, ...plan.frame.references.map((reference) => reference.artifactId)];
  const frame = await priced(engine, compileShortFrameStep(plan), images.length > 0 ? { image: images } : {});
  const segments = await Promise.all(plan.segments.map((_, index) => index === 0
    ? priced(engine, compileShortClipStep(plan, PLACEHOLDER_FRAME), { first_frame: [PLACEHOLDER_FRAME], ...(characters.length > 0 ? { image: characters } : {}) })
    : priced(engine, compileShortContinuationStep(plan, index, PLACEHOLDER_CLIP), { video: [PLACEHOLDER_CLIP] })));
  const videos = summed(segments);
  return { frame, storyboards: { usd: 0, warnings: [] }, videos, total: summed([frame, videos]), segments };
}

export async function shortFingerprint(engine: Engine, plan: GoalShortPlan, stage: ShortStage, index: number, sourceArtifactId: string | null): Promise<string> {
  const characters = plan.character.references.map((reference) => reference.artifactId);
  if (stage === "frame") {
    const { prompt, ...settings } = plan.frame;
    return JSON.stringify({
      prompt,
      rules: plan.rules.frame,
      settings: { ...settings, references: undefined, aspectRatio: plan.aspectRatio },
      references: await goalReferenceHashes(engine, [...characters, ...plan.frame.references.map((reference) => reference.artifactId)]),
    });
  }
  return JSON.stringify({
    prompt: plan.segments[index]?.prompt ?? null,
    seconds: plan.segments[index]?.seconds ?? null,
    rules: { video: plan.rules.video, silence: plan.rules.silence },
    settings: { ...plan.video, aspectRatio: plan.aspectRatio },
    references: await goalReferenceHashes(engine, characters),
    sourceArtifactId,
  });
}

function selectedOutput(goal: GoalRecord, stage: ShortStage, index: number): GoalStageOutput | undefined {
  return goal.stages[stage]?.outputs.find((output) => output.index === index);
}

function segmentSource(goal: GoalRecord, index: number): string | null {
  return (index === 0 ? selectedOutput(goal, "frame", 0) : selectedOutput(goal, "videos", index - 1))?.artifactId ?? null;
}

export function shortSegmentStale(goal: GoalRecord, index: number): boolean {
  const output = selectedOutput(goal, "videos", index);
  if (!output) return false;
  if (index > 0 && shortSegmentStale(goal, index - 1)) return true;
  const attempt = goal.stages.videos?.attempts?.find((candidate) => candidate.index === index && candidate.artifactId === output.artifactId);
  return Boolean(attempt?.frameArtifactId && attempt.frameArtifactId !== segmentSource(goal, index));
}

export function currentShortClip(goal: GoalRecord): GoalStageOutput | null {
  const outputs = [...(goal.stages.videos?.outputs ?? [])].sort((left, right) => left.index - right.index);
  return outputs.at(-1) ?? null;
}

export function nextShortSegment(goal: GoalRecord, plan: GoalShortPlan): number | null {
  for (let index = 0; index < plan.segments.length; index += 1) {
    if (!selectedOutput(goal, "videos", index) || shortSegmentStale(goal, index)) return index;
  }
  return null;
}

function outputAddress(document: NotebookDocument, output: GoalStageOutput | undefined): string {
  const cell = output?.cellId ? document.cells.find((candidate) => candidate.id === output.cellId) : null;
  if (!cell || resolveNotebookCellArtifactId(document, cell) !== output?.artifactId) {
    throw new Error("An approved frame or clip changed or was removed. Regenerate it before continuing.");
  }
  return notebookGridTag(cell.slot);
}

function assertShortRevision(engine: Engine, goal: GoalRecord, revision: unknown): GoalShortContent & { plan: GoalShortPlan } {
  const content = requireGoalShortContent(engine, goal);
  if (content.revision !== revision) throw new Error("The goal changed. Review the current version before approving it.");
  if (!content.plan) throw new Error("This short has no plan yet. Wait for planning to finish.");
  return { ...content, plan: content.plan };
}

async function toolLookup(engine: Engine) {
  const { getAllToolDefs } = await import("./tools/index.js");
  const defs = getAllToolDefs(engine);
  return { defs, lookup: (name: string) => defs.find((def) => def.name === name) };
}

async function queueShortPlanning(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  const planning = saveGoal(engine, { ...goal, status: "planning", error: null });
  try {
    const job = await queue.enqueue(`goal-plan-${goal.goalId}-${uuidv7()}`, { type: "plan_goal", bookId: goal.bookId, goalId: goal.goalId });
    return saveGoal(engine, { ...readGoal(engine, goal.goalId), planningJobId: job.id });
  } catch (error) {
    saveGoal(engine, { ...planning, status: "failed", error: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

export async function createShortGoal(engine: Engine, bookId: string, notebookId: string, input: { brief: string; requestId: string; plan?: GoalShortPlan }): Promise<GoalRecord> {
  const brief = input.brief;
  let content: GoalShortContent;
  let referenceNotes: ReferenceNote[] = [];
  if (input.plan) {
    const plan = goalShortPlanSchema.parse(input.plan);
    content = { brief, revision: 1, draft: null, plan, estimate: await estimateShort(engine, plan), notes: [] };
  } else {
    const timing = shortTiming(brief);
    const planning = shortPlannerNeeded(brief, timing.segmentSeconds.length);
    const character = await reconcileMainCharacter(engine);
    const references = await characterReferences(engine, notebookId, character.referenceArtifactIds);
    const mentioned = await briefReferences(engine, notebookId, brief, new Set(character.referenceArtifactIds));
    referenceNotes = mentioned.notes;
    const draft: GoalShortDraft = {
      aspectRatio: timing.aspectRatio,
      segmentSeconds: timing.segmentSeconds,
      character: { name: character.name, description: character.description, references },
      extraReferences: mentioned.references,
    };
    if (planning) {
      content = { brief, revision: 1, draft, plan: null, estimate: emptyGoalEstimates(), notes: [] };
    } else {
      const authored = shortAuthoredCopy(brief, timing.segmentSeconds.length);
      const framePrompt = authored.frame ?? "";
      const plan = buildGoalShortPlan({ ...draft, title: shortTitle(brief, framePrompt), framePrompt, beats: authored.beats.map((beat) => beat ?? "") });
      content = { brief, revision: 1, draft, plan, estimate: await estimateShort(engine, plan), notes: [] };
    }
  }
  const goalId = uuidv7();
  const cell = await createGoalShortCell(engine, notebookId, goalId, content);
  const timestamp = new Date().toISOString();
  const goal: GoalRecord = {
    goalId, bookId, notebookId, cellId: cell.id, requestId: input.requestId, status: content.plan ? "review" : "planning", planVersion: 4,
    stage: "frame", stages: {}, chainId: null, planningJobId: null, clipIds: [], trackId: null, assembly: null, error: null,
    dismissedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  if (referenceNotes.length > 0) {
    content = { ...content, notes: renderReferenceNotes(readNotebook(engine, notebookId), referenceNotes) };
    await writeGoalShortContent(engine, goal, content);
  }
  const saved = saveGoal(engine, goal);
  return content.plan ? saved : queueShortPlanning(engine, saved);
}

async function adoptCharacterReferences(engine: Engine, goal: GoalRecord, content: GoalShortContent & { plan: GoalShortPlan }) {
  const character = await reconcileMainCharacter(engine);
  if (character.referenceArtifactIds.length === 0) throw new Error(NO_CHARACTER_REFERENCE);
  const plan = withShortCharacterReferences(content.plan, await characterReferences(engine, goal.notebookId, character.referenceArtifactIds));
  const next = { ...content, plan, estimate: await estimateShort(engine, plan), revision: content.revision + 1 };
  await writeGoalShortContent(engine, goal, next);
  return next;
}

export async function priceShortFrame(engine: Engine, goal: GoalRecord, characterIds: readonly string[]): Promise<void> {
  if (goal.planVersion !== 4 || goal.status !== "review" || characterIds.length === 0 || (goal.stages.frame?.outputs.length ?? 0) > 0) return;
  const content = requireGoalShortContent(engine, goal);
  if (!content.plan || content.plan.character.references.length > 0 || content.estimate.frame.usd !== null) return;
  const plan = withShortCharacterReferences(content.plan, await characterReferences(engine, goal.notebookId, characterIds));
  await writeGoalShortContent(engine, goal, { ...content, estimate: await estimateShort(engine, plan) });
}

async function rewrittenShortPrompt(goal: GoalRecord, stage: ShortStage, index: number, feedback: string, revision: number): Promise<string> {
  try {
    const result = await queue.enqueueAndWait<{ prompt: string }>(`goal-revise-${goal.goalId}-${uuidv7()}`, {
      type: "revise_goal_prompt", bookId: goal.bookId, goalId: goal.goalId, stage, index, feedback, revision,
    }, REVISE_TIMEOUT_MS);
    return result.prompt;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/^Job \d+ timed out/u.test(message)) throw new Error("Writing the feedback into the prompt took too long. Revise again, or edit the prompt and regenerate.");
    throw new Error(message.replace(/^Job \d+ (?:failed|aborted): /u, ""));
  }
}

async function revisedShortContent(engine: Engine, goal: GoalRecord, content: GoalShortContent & { plan: GoalShortPlan }, stage: ShortStage, index: number, feedback: string) {
  const prompt = await rewrittenShortPrompt(goal, stage, index, feedback, content.revision);
  const plan = goalShortPlanSchema.parse(stage === "frame"
    ? { ...content.plan, frame: { ...content.plan.frame, prompt } }
    : { ...content.plan, segments: content.plan.segments.map((segment, position) => position === index ? { ...segment, prompt } : segment) });
  const next = { ...content, plan, estimate: await estimateShort(engine, plan), revision: content.revision + 1 };
  await writeGoalShortContent(engine, goal, next);
  return next;
}

async function clipSeconds(engine: Engine, artifactId: string): Promise<number> {
  const manifest = await engine.files.manifest(artifactId);
  const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, "video") : null;
  if (!manifest.ok || !file) throw new Error("The current clip has no readable video. Regenerate it before continuing.");
  return (await probeVideo(join(manifest.value.path, file.name))).duration;
}

async function continuationSource(engine: Engine, goal: GoalRecord, index: number): Promise<GoalStageOutput> {
  const previous = selectedOutput(goal, "videos", index - 1);
  if (!previous) throw new Error(`Generate segment ${index} before continuing the short.`);
  if (shortSegmentStale(goal, index - 1)) throw new Error(`Segment ${index} is out of date. Approve it again before continuing the short.`);
  const seconds = await clipSeconds(engine, previous.artifactId);
  if (seconds < EXTEND_SOURCE_SECONDS.minimum || seconds > EXTEND_SOURCE_SECONDS.maximum) {
    throw new Error(`The current clip runs ${seconds.toFixed(2)} seconds, and H3 Extend takes a source of ${EXTEND_SOURCE_SECONDS.minimum} to ${EXTEND_SOURCE_SECONDS.maximum} seconds.`);
  }
  return previous;
}

export function shortFinishSource(engine: Engine, goal: GoalRecord): string {
  const plan = requireGoalShortContent(engine, goal).plan;
  const clip = currentShortClip(goal);
  if (!plan || !clip || nextShortSegment(goal, plan) !== null) throw new Error("Generate every segment of the short before finishing it.");
  return clip.artifactId;
}

async function ensureShortSpace(engine: Engine, goal: GoalRecord, stage: ShortStage): Promise<void> {
  const placed = await mutateNotebook(engine, goal.notebookId, "goal_stage_space", (document) => {
    if (NOTEBOOK_GRID_CAPACITY - notebookOccupiedSlots(document.cells).length < 2) throw new Error("The notebook needs two empty cells for each frame or clip");
    return arrangeGoalNotebook(document, { generators: 1, images: stage === "frame" ? 1 : 0, videos: stage === "videos" ? 1 : 0 });
  });
  if (!placed.ok) throw new Error(placed.error.message);
}

function shortTarget(goal: GoalRecord, plan: GoalShortPlan, args: GoalArgs, regenerate: boolean): { stage: ShortStage; index: number } {
  if (!regenerate) {
    if (goal.stage !== "videos") return { stage: "frame", index: 0 };
    const index = nextShortSegment(goal, plan);
    if (index === null) throw new Error("Every segment of this short is generated. Finish it, regenerate a segment or add a beat.");
    return { stage: "videos", index };
  }
  const stage = args.stage !== undefined || args.action === "revise" ? stageSchema.parse(args.stage) : goal.stage === "videos" ? "frame" : null;
  if (!stage) throw new Error("There are no stage outputs to regenerate yet");
  const index = args.index === undefined ? 0 : z.number().int().nonnegative().parse(args.index);
  if (stage === "frame" && index !== 0) throw new Error("A short has one frame");
  if (stage === "videos" && index >= plan.segments.length) throw new Error(`This short has ${plan.segments.length} segments.`);
  if (!selectedOutput(goal, stage, index)) throw new Error("There is no current output to regenerate or revise");
  return { stage, index };
}

export async function startShortStage(engine: Engine, goal: GoalRecord, args: GoalArgs, regenerate: boolean): Promise<GoalRecord> {
  const active = goal.stage === "videos" ? "videos" : "frame";
  if (!regenerate && goal.status === "running" && goal.stages[active]?.revision === args.revision) return goal;
  if (!(regenerate ? ["review", "completed", "failed", "interrupted"] : ["review"]).includes(goal.status)) {
    throw new Error("Review the goal before approving, regenerating or revising a stage");
  }
  let content = assertShortRevision(engine, goal, args.revision);
  const { stage, index } = shortTarget(goal, content.plan, args, regenerate);
  const feedback = args.action === "revise" ? feedbackSchema.parse(args.feedback) : null;
  if (!process.env.FAL_API_KEY) throw new Error(NO_FAL_KEY);
  if (feedback && !getApiKey("OPENAI_API_KEY")) throw new Error(NO_OPENAI_KEY);
  if (stage === "frame" && content.plan.character.references.length === 0) content = await adoptCharacterReferences(engine, goal, content);
  if (stage === "videos") outputAddress(readNotebook(engine, goal.notebookId), selectedOutput(goal, "frame", 0));
  const sourceClip = stage === "videos" && index > 0 ? await continuationSource(engine, goal, index) : null;
  await ensureShortSpace(engine, goal, stage);
  if (feedback) content = await revisedShortContent(engine, goal, content, stage, index, feedback);
  const document = readNotebook(engine, goal.notebookId);
  const plan = refreshGoalShortPlan(content.plan, document);
  const source = stage === "videos" ? segmentSource(goal, index) : null;
  if (stage === "videos" && index === 0) {
    const frame = selectedOutput(goal, "frame", 0)!;
    const frameAttempt = goal.stages.frame?.attempts?.find((attempt) => attempt.artifactId === frame.artifactId && attempt.fingerprint);
    if (frameAttempt?.fingerprint && frameAttempt.fingerprint !== await shortFingerprint(engine, plan, "frame", 0, null)) {
      throw new Error("The frame prompt or references changed after this frame was made. Regenerate the frame before continuing.");
    }
  }
  const step = stage === "frame" ? compileShortFrameStep(plan)
    : sourceClip ? compileShortContinuationStep(plan, index, outputAddress(document, sourceClip))
      : compileShortClipStep(plan, outputAddress(document, selectedOutput(goal, "frame", 0)));
  const fingerprint = await shortFingerprint(engine, plan, stage, index, source);
  const previous = goal.stages[stage];
  const attemptCount = previous?.attempts?.length ?? 0;
  const { defs, lookup } = await toolLookup(engine);
  const chain = await preflightAndAccept({
    action: "run", version: 1, book_id: goal.bookId, notebook_id: goal.notebookId,
    request_id: `goal:${goal.goalId}:${stage}:${index}:${content.revision}:${feedback ? "revise" : regenerate ? "regenerate" : "approve"}:${attemptCount}`,
    steps: [step],
  }, {
    engine, bookId: goal.bookId, notebookId: goal.notebookId,
    toolSchemas: new Map(defs.map((def) => [def.name, def.schema])), autoApplyTools: new Set(),
    effectForTool: () => "generation",
  }, lookup, { actor: "chat" });
  const approvedAt = new Date().toISOString();
  const { finish: _finish, ...stored } = goal;
  return saveGoal(engine, {
    ...(regenerate ? stored : goal),
    stage, chainId: chain.chainId, status: "running", error: null,
    ...(regenerate ? { finish: null, resumeFinish: goal.finish ?? null } : stage === "videos" ? { finish: null } : {}),
    resumeStage: regenerate ? goal.resumeStage ?? (goal.stage === "frame" ? "frame" : "videos") : null,
    resumeStatus: regenerate ? goal.status === "completed" || goal.resumeStatus === "completed" ? "completed" : "review" : null,
    resumeOutputs: regenerate ? previous?.outputs ?? [] : null,
    stages: { ...goal.stages, [stage]: {
      chainId: chain.chainId, revision: content.revision, approvedAt, shotIndexes: [index],
      outputs: previous?.outputs ?? [], previousChainIds: previous ? [...previous.previousChainIds, previous.chainId] : [],
      attempts: [...(previous?.attempts ?? []), {
        stage, index, chainId: chain.chainId, stepId: step.id, artifactId: null, cellId: null,
        basePrompt: stage === "videos" ? plan.segments[index]!.prompt : plan.frame.prompt, feedback, fingerprint,
        parentArtifactId: feedback ? selectedOutput(goal, stage, index)?.artifactId ?? null : null,
        frameArtifactId: source, createdAt: approvedAt,
      }],
    } },
  });
}

export function selectShortVersion(engine: Engine, goal: GoalRecord, args: GoalArgs): GoalRecord {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Select a version while reviewing the goal");
  if (args.revision !== undefined && requireGoalShortContent(engine, goal).revision !== args.revision) {
    throw new Error("The goal changed. Review the current version before approving it.");
  }
  const stage = stageSchema.parse(args.stage);
  const index = z.number().int().nonnegative().parse(args.index);
  const artifactId = z.string().uuid().parse(args.artifact_id);
  const run = goal.stages[stage];
  const attempts = goalStageAttempts(goal, stage);
  const attempt = attempts.find((item) => item.stage === stage && item.index === index && item.artifactId === artifactId);
  const step = attempt ? getChainRun(engine, attempt.chainId)?.steps.find((item) => item.id === attempt.stepId) : null;
  if (!run || !attempt || step?.status !== "completed") throw new Error("Choose a completed version of this goal's output");
  const document = readNotebook(engine, goal.notebookId);
  const producer = document.cells.find((cell) => cell.inputs?.chainRunId === `${attempt.chainId}:${attempt.stepId}`);
  const output = { index, artifactId, cellId: attempt.cellId, producerCellId: producer?.id ?? null, address: null };
  const address = outputAddress(document, output);
  const changed = selectedOutput(goal, stage, index)?.artifactId !== artifactId;
  const outputs = [...run.outputs.filter((item) => item.index !== index), { ...output, address }].sort((a, b) => a.index - b.index);
  const next = { ...goal, stages: { ...goal.stages, [stage]: { ...run, attempts, outputs } } };
  if (!changed) return saveGoal(engine, next);
  const plan = requireGoalShortContent(engine, goal).plan;
  const clip = stage === "videos" && plan && nextShortSegment(next, plan) === null ? currentShortClip(next) : null;
  const finish = clip ? { status: "review" as const, sourceArtifactId: clip.artifactId, finalArtifactId: null, error: null } : null;
  return saveGoal(engine, { ...next, status: "review", error: null, finish });
}

function lockedSettings(plan: GoalShortPlan) {
  return { aspectRatio: plan.aspectRatio, video: plan.video, rules: plan.rules, frame: { ...plan.frame, prompt: "", references: [] } };
}

function lockedReferences(plan: GoalShortPlan) {
  const reference = (item: GoalShortImageRef) => ({ artifactId: item.artifactId, cellId: item.cellId, objectHash: item.objectHash, slot: item.slot });
  return {
    character: { ...plan.character, references: plan.character.references.map(reference) },
    frame: plan.frame.references.map(reference),
    finish: plan.finish,
  };
}

export async function updateShortGoal(engine: Engine, goal: GoalRecord, args: GoalArgs): Promise<GoalRecord> {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Wait until generation stops before editing the goal");
  const content = assertShortRevision(engine, goal, args.revision);
  const previous = content.plan;
  const plan = goalShortPlanSchema.parse(args.plan);
  if (JSON.stringify(lockedReferences(previous)) !== JSON.stringify(lockedReferences(plan))) throw new Error(REFERENCES_LOCKED);
  const frameMade = (goal.stages.frame?.outputs.length ?? 0) > 0;
  if (frameMade && JSON.stringify(lockedSettings(previous)) !== JSON.stringify(lockedSettings(plan))) throw new Error(SETTINGS_LOCKED);
  const generated = goal.stages.videos?.outputs.map((output) => output.index) ?? [];
  if (generated.some((index) => plan.segments[index]?.seconds !== previous.segments[index]?.seconds)) throw new Error(SEGMENT_LOCKED);
  if (JSON.stringify(previous) === JSON.stringify(plan)) return goal;
  const generatedPromptChanged = (frameMade && previous.frame.prompt !== plan.frame.prompt)
    || generated.some((index) => previous.segments[index]?.prompt !== plan.segments[index]?.prompt);
  await writeGoalShortContent(engine, goal, { ...content, plan, estimate: await estimateShort(engine, plan), revision: content.revision + 1 });
  const reopened = generatedPromptChanged || plan.segments.length !== previous.segments.length;
  return saveGoal(engine, {
    ...goal,
    ...(reopened ? { status: "review" as const, error: null } : {}),
    ...(generatedPromptChanged ? { finish: null } : {}),
  });
}

export async function queueShortRealismCheck(engine: Engine, goal: GoalRecord, args: GoalArgs): Promise<GoalRecord> {
  const stage = z.enum(["frame", "videos"]).parse(args.stage);
  const index = z.number().int().min(0).parse(args.index ?? 0);
  const output = goal.stages[stage]?.outputs.find((item) => item.index === index);
  const manifest = output ? await engine.files.manifest(output.artifactId) : null;
  if (!output || !manifest?.ok || !findPrimaryMediaFile(manifest.value.files, stage === "frame" ? "image" : "video")) {
    throw new Error("Generate this frame or clip, and keep it selected, before checking it for AI tells.");
  }
  if (!getApiKey("OPENAI_API_KEY")) throw new Error("Set OPENAI_API_KEY in Settings before checking for AI tells.");
  if (goal.realism?.[output.artifactId]?.status === "running") return goal;
  const job = await queue.enqueue(`goal-realism-${output.artifactId}-${uuidv7()}`, {
    type: "check_goal_realism", bookId: goal.bookId, goalId: goal.goalId, artifactId: output.artifactId, stage, index,
  });
  return saveGoal(engine, { ...goal, realism: { ...goal.realism, [output.artifactId]: { status: "running", checkedAt: null, findings: [], error: null, jobId: job.id } } });
}

export async function retryShortGoal(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  if (goal.status !== "failed" && goal.status !== "interrupted") throw new Error("Only a goal that failed or was interrupted can be retried");
  const content = requireGoalShortContent(engine, goal);
  if (!content.plan) return queueShortPlanning(engine, goal);
  if (!goal.chainId) throw new Error("There is no generation to retry. Approve the current stage.");
  const stage = goal.stage === "videos" ? "videos" : "frame";
  const run = goal.stages[stage];
  if (run && run.revision !== content.revision) throw new Error("The plan changed after this attempt. Regenerate using the current plan instead of retrying the older request.");
  const plan = refreshGoalShortPlan(content.plan, readNotebook(engine, goal.notebookId));
  for (const attempt of run?.attempts ?? []) {
    if (attempt.chainId !== goal.chainId || !attempt.fingerprint) continue;
    const source = stage === "videos" ? segmentSource(goal, attempt.index) : null;
    if (attempt.fingerprint !== await shortFingerprint(engine, plan, stage, attempt.index, source)) throw new Error(STALE_RETRY);
  }
  if (!process.env.FAL_API_KEY) throw new Error(NO_FAL_KEY);
  const { lookup } = await toolLookup(engine);
  retryChainRun(engine, goal.chainId, lookup);
  return saveGoal(engine, { ...goal, status: "running", error: null });
}
