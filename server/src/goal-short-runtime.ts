import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile, resolveNotebookCellArtifactId } from "videobook-engine";
import { notebookGridTag, notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import { replaceNotebookMentions, scanNotebookMentions, type NotebookMention } from "videobook-engine/notebook-mentions";
import { getApiKey } from "./api-key.js";
import { getChainRun, preflightAndAccept, retryChainRun, type ChainRunRecord } from "./chain-executor.js";
import type { ChainStep } from "./chain-plan.js";
import { probeVideo } from "./ffmpeg.js";
import {
  buildGoalShortPlan, compileShortClipStep, compileShortContinuationStep, compileShortFrameStep, compileShortStoryboardStep, formatShortSeconds,
  goalShortPlanSchema, refreshGoalShortPlan, shortPlanTitleInput, shortStoryboardOf, shortTiming,
  type GoalShortDraft, type GoalShortImageRef, type GoalShortPlan, type ShortStoryboard, type ShortStoryboardVideo,
} from "./goal-short-plan.js";
import { shortAuthoredCopy, shortBriefPlan, shortPlannerNeeded, shortTitle } from "./goal-short-planner.js";
import { briefMention, renderReferenceNotes, type ReferenceNote } from "./goal-short-references.js";
import { captureStoryboardFrames, shortStoryboard, videoStoryboardMoments } from "./goal-short-storyboard.js";
import { goalReferenceHashes } from "./goal-reference-images.js";
import { goalStageAttempts } from "./goal-stills.js";
import {
  activeGoalStage, createGoalShortCell, emptyGoalEstimates, readGoal, requireGoalShortContent, saveGoal, writeGoalShortContent,
  type GoalEstimate, type GoalEstimates, type GoalFinish, type GoalGenerationStage, type GoalRecord, type GoalShortContent, type GoalStageOutput,
} from "./goal-store.js";
import { goalTitleEstimate, type GoalTitleShort } from "./graphics/suggest.js";
import { assessToolCallEstimate } from "./jobs/cost-estimate-assessment.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { resolveNotebookArtifactReference } from "./notebook-reference-resolver.js";
import { queue } from "./queue.js";

type GoalArgs = Record<string, unknown>;
type ShortReference = Omit<GoalShortImageRef, "slot">;
type ShortTarget = { stage: GoalGenerationStage; indexes: number[] };
type BriefReferences = { references: ShortReference[]; storyboard: ShortStoryboard | null; notes: ReferenceNote[] };
export type StoryboardFrameFailure = { kind: "failed" | "not-run"; message: string };

const EXTRA_REFERENCE_LIMIT = 12;
const NO_FAL_KEY = "Set FAL_API_KEY in Settings before generating this stage";
const NO_OPENAI_KEY = "Set OPENAI_API_KEY in Settings to revise with feedback, or edit the prompt and regenerate.";
const REVISE_TIMEOUT_MS = 240_000;
const SETTINGS_LOCKED = "Models, resolution, aspect ratio and rules stay with this short once its frame exists. Start a new /goal to change them.";
const REFERENCES_LOCKED = "The source images stay with this short. Start a new /goal to change them.";
const STORYBOARD_LOCKED = "The storyboard's video and frames stay with this short. Start a new /goal to change them.";
const STORYBOARD_FIRST = "Clean the storyboard first: approve the storyboard stage to remove its on-screen graphics before the frame is made.";
const SEGMENT_LOCKED = "A generated segment keeps its place and seconds. Regenerate it, or start a new /goal to change them.";
const TITLE_WHILE_FINISHING = "Wait until finishing stops before changing the burned title.";
const STALE_RETRY = "The references or selected versions changed after this attempt. Regenerate using the current selection instead of retrying the older request.";
const EXTEND_SOURCE_SECONDS = { minimum: 1.625, maximum: 60 };
const PLACEHOLDER_FRAME = "https://videobook.invalid/short-frame.jpg";
const PLACEHOLDER_CLIP = "https://videobook.invalid/short-clip.mp4";
const stageSchema = z.enum(["storyboards", "frame", "videos"]);
export const shortFeedbackSchema = z.string().trim().min(1).max(2000);

function feedbackLabel(engine: Engine, document: NotebookDocument, mention: NotebookMention): string {
  const resolved = resolveNotebookArtifactReference({ engine, documents: [document], reference: mention.reference });
  if ("code" in resolved || !resolved.cellId) return mention.reference;
  const label = document.cells.find((candidate) => candidate.id === resolved.cellId)?.label?.trim();
  return label || mention.reference;
}

function plainFeedback(engine: Engine, notebookId: string, feedback: string): string {
  const document = readNotebook(engine, notebookId);
  const seen = new Set<string>();
  const replacements: { reference: string; replacement: string }[] = [];
  for (const mention of scanNotebookMentions(feedback)) {
    if (seen.has(mention.reference)) continue;
    seen.add(mention.reference);
    replacements.push({ reference: mention.reference, replacement: feedbackLabel(engine, document, mention) });
  }
  return replaceNotebookMentions(feedback, replacements);
}

function readNotebook(engine: Engine, notebookId: string): NotebookDocument {
  const notebook = engine.notebooks.read(notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  return notebook.value;
}

function mentionTimestamp(brief: string, mention: NotebookMention): number | null {
  const match = /^\s+at\s+(\d+(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/iu.exec(brief.slice(mention.end));
  if (!match) return null;
  const seconds = Number(match[1]);
  return Number.isFinite(seconds) ? seconds : null;
}

async function mentionedStoryboard(
  engine: Engine,
  bookId: string,
  notebookId: string,
  video: ShortStoryboardVideo,
  mention: string,
  fromSeconds: number | null,
): Promise<{ storyboard: ShortStoryboard | null; note: ReferenceNote }> {
  const skipped = (text: string) => ({ storyboard: null, note: { kind: "text" as const, text } });
  let moments: number[];
  try {
    moments = await videoStoryboardMoments(engine, bookId, video.artifactId, fromSeconds === null ? {} : { fromSeconds });
  } catch {
    return skipped(`${mention} is a video, but its frames could not be read, so it was skipped.`);
  }
  if (moments.length === 0) {
    return skipped(fromSeconds === null
      ? `${mention} is a video, but it is too short for a storyboard, so it was skipped.`
      : `${mention} is a video, but it has no frames to storyboard after ${formatShortSeconds(fromSeconds)} s, so it was skipped.`);
  }
  try {
    const frames = await captureStoryboardFrames(engine, notebookId, { artifactId: video.artifactId, ...(video.cellId ? { cellId: video.cellId } : {}) }, moments);
    return {
      storyboard: shortStoryboard(video, frames),
      note: { kind: "storyboard", mention, frames: frames.map((frame) => ({ cellId: frame.cellId, atSeconds: frame.atSeconds })) },
    };
  } catch (error) {
    return skipped(`${mention} is a video, but it was skipped. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function briefReferences(engine: Engine, bookId: string, notebookId: string, brief: string): Promise<BriefReferences> {
  const references: ShortReference[] = [];
  const notes: (ReferenceNote | null)[] = [];
  const ignored = new Set<string>();
  const seen = new Set<string>();
  let video: { found: ShortStoryboardVideo; mention: NotebookMention } | null = null;
  for (const mention of scanNotebookMentions(brief)) {
    if (seen.has(mention.reference)) continue;
    seen.add(mention.reference);
    const found = await briefMention(engine, notebookId, mention.reference, { ignoreArtifactIds: ignored, mention: mention.raw });
    if (found.kind === "ignored") continue;
    if (found.kind === "skipped") {
      notes.push({ kind: "text", text: found.note });
      continue;
    }
    if (found.kind === "image") {
      ignored.add(found.image.artifactId);
      if (references.length < EXTRA_REFERENCE_LIMIT) references.push(found.image);
      else notes.push({ kind: "text", text: `${mention.raw} was skipped because a short takes at most ${EXTRA_REFERENCE_LIMIT} mentioned images.` });
      continue;
    }
    ignored.add(found.video.artifactId);
    if (video) {
      notes.push({ kind: "text", text: `${mention.raw} is another video and was skipped: the storyboard comes from the first video the brief mentions.` });
      continue;
    }
    video = { found: found.video, mention };
    notes.push(null);
  }
  const made = video ? await mentionedStoryboard(engine, bookId, notebookId, video.found, video.mention.raw, mentionTimestamp(brief, video.mention)) : null;
  return { references, storyboard: made?.storyboard ?? null, notes: notes.map((note) => note ?? made!.note) };
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

function shortImageIds(plan: GoalShortPlan, clip: boolean): string[] {
  if (plan.version === 5) return plan.sourceImages.map((reference) => reference.artifactId);
  return (clip ? plan.character.references : [...plan.character.references, ...plan.frame.references]).map((reference) => reference.artifactId);
}

export async function estimateShort(engine: Engine, plan: GoalShortPlan, short: GoalTitleShort): Promise<GoalEstimates> {
  const storyboard = shortStoryboardOf(plan);
  const firstFrame = storyboard?.frames[0] ?? null;
  const frameIds = [...shortImageIds(plan, false), ...(firstFrame ? [firstFrame.artifactId] : [])];
  const clipIds = shortImageIds(plan, true);
  const storyboardFrames = storyboard
    ? await Promise.all(storyboard.frames.map((frame) => priced(engine, compileShortStoryboardStep(storyboard, frame.index), { image: [frame.artifactId] })))
    : [];
  const frame = await priced(engine, compileShortFrameStep(plan, firstFrame?.address ?? null), frameIds.length > 0 ? { image: frameIds } : {});
  const segments = await Promise.all(plan.segments.map((_, index) => index === 0
    ? priced(engine, compileShortClipStep(plan, PLACEHOLDER_FRAME), { first_frame: [PLACEHOLDER_FRAME], ...(clipIds.length > 0 ? { image: clipIds } : {}) })
    : priced(engine, compileShortContinuationStep(plan, index, PLACEHOLDER_CLIP), { video: [PLACEHOLDER_CLIP] })));
  const storyboards = summed(storyboardFrames);
  const videos = summed(segments);
  const title = goalTitleEstimate({ brief: short.brief, draft: short.draft, plan });
  return { frame, storyboards, videos, total: summed([storyboards, frame, videos]), segments, ...(storyboard ? { storyboardFrames } : {}), title };
}

export async function shortFingerprint(engine: Engine, plan: GoalShortPlan, stage: GoalGenerationStage, index: number, sourceArtifactId: string | null): Promise<string> {
  const storyboard = shortStoryboardOf(plan);
  if (stage === "storyboards") {
    const frame = storyboard?.frames[index];
    return JSON.stringify({
      prompt: frame?.prompt ?? null,
      model: storyboard?.model ?? null,
      aspectRatio: frame?.aspectRatio ?? null,
      references: await goalReferenceHashes(engine, frame ? [frame.artifactId] : []),
    });
  }
  if (stage === "frame") {
    const { prompt, ...settings } = plan.frame;
    return JSON.stringify({
      prompt,
      rules: plan.rules.frame,
      settings: plan.version === 5
        ? { ...settings, aspectRatio: plan.aspectRatio }
        : { ...settings, references: undefined, aspectRatio: plan.aspectRatio },
      references: await goalReferenceHashes(engine, shortImageIds(plan, false)),
      ...(storyboard ? { storyboardFrame: sourceArtifactId } : {}),
    });
  }
  return JSON.stringify({
    prompt: plan.segments[index]?.prompt ?? null,
    seconds: plan.segments[index]?.seconds ?? null,
    rules: { video: plan.rules.video, silence: plan.rules.silence },
    settings: { ...plan.video, aspectRatio: plan.aspectRatio },
    references: await goalReferenceHashes(engine, shortImageIds(plan, true)),
    sourceArtifactId,
  });
}

function selectedOutput(goal: GoalRecord, stage: GoalGenerationStage, index: number): GoalStageOutput | undefined {
  return goal.stages[stage]?.outputs.find((output) => output.index === index);
}

function stageSource(goal: GoalRecord, stage: GoalGenerationStage, index: number): string | null {
  if (stage === "storyboards") return null;
  if (stage === "frame") return selectedOutput(goal, "storyboards", 0)?.artifactId ?? null;
  return (index === 0 ? selectedOutput(goal, "frame", 0) : selectedOutput(goal, "videos", index - 1))?.artifactId ?? null;
}

function madeFromStaleSource(goal: GoalRecord, stage: "frame" | "videos", index: number): boolean {
  const output = selectedOutput(goal, stage, index);
  if (!output) return false;
  const attempt = goal.stages[stage]?.attempts?.find((candidate) => candidate.index === index && candidate.artifactId === output.artifactId);
  return Boolean(attempt?.frameArtifactId && attempt.frameArtifactId !== stageSource(goal, stage, index));
}

export function shortFrameStale(goal: GoalRecord): boolean {
  return madeFromStaleSource(goal, "frame", 0);
}

export function shortSegmentStale(goal: GoalRecord, index: number): boolean {
  if (!selectedOutput(goal, "videos", index)) return false;
  if (index > 0 && shortSegmentStale(goal, index - 1)) return true;
  return madeFromStaleSource(goal, "videos", index);
}

function shortStoryboardClean(goal: GoalRecord, plan: GoalShortPlan | null): boolean {
  return (shortStoryboardOf(plan)?.frames ?? []).every((frame) => selectedOutput(goal, "storyboards", frame.index));
}

function notRunReason(chain: ChainRunRecord): string {
  if (chain.status === "interrupted") return "Not run: the clean-up was interrupted.";
  const failed = chain.continueOnFailure ? undefined : chain.steps.find((step) => step.status === "failed");
  const number = failed ? /\d+$/u.exec(failed.id)?.[0] : undefined;
  if (failed) return number ? `Not run: storyboard ${number} failed first.` : "Not run: another frame failed first.";
  return "Not run: the clean-up was stopped.";
}

export function storyboardFrameFailure(engine: Engine, goal: GoalRecord, index: number): StoryboardFrameFailure | null {
  const attempt = goalStageAttempts(goal, "storyboards").filter((candidate) => candidate.index === index).at(-1);
  const chain = attempt ? getChainRun(engine, attempt.chainId) : null;
  const step = chain?.steps.find((candidate) => candidate.id === attempt?.stepId);
  if (!chain || !step) return null;
  if (step.status === "failed") return { kind: "failed", message: step.error ?? "The clean-up failed." };
  if (selectedOutput(goal, "storyboards", index) || !["interrupted", "skipped", "cancelled", "rejected"].includes(step.status)) return null;
  return { kind: "not-run", message: notRunReason(chain) };
}

export function storyboardReview(goal: GoalRecord, next: GoalRecord, plan: GoalShortPlan | null): GoalRecord {
  const finish = goal.finish ?? goal.resumeFinish ?? null;
  const resumed = goal.resumeStage && goal.resumeStage !== "storyboards" ? goal.resumeStage : null;
  const stage = goal.stage !== "storyboards" ? goal.stage : resumed ?? (shortStoryboardClean(next, plan) ? "frame" : "storyboards");
  return {
    ...next, stage, status: finish?.status === "completed" && finish.finalArtifactId ? "completed" : "review", error: null, finish,
    resumeStage: null, resumeStatus: null, resumeOutputs: null, resumeFinish: null,
  };
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
    throw new Error("An approved storyboard frame, frame or clip changed or was removed. Regenerate it before continuing.");
  }
  return notebookGridTag(cell.slot);
}

function cleanStoryboardFrame(goal: GoalRecord): GoalStageOutput {
  const output = selectedOutput(goal, "storyboards", 0);
  if (!output) throw new Error(STORYBOARD_FIRST);
  return output;
}

function assertRawFrames(document: NotebookDocument, storyboard: ShortStoryboard, indexes: readonly number[]): void {
  for (const index of indexes) {
    const frame = storyboard.frames[index]!;
    const cell = document.cells.find((candidate) => candidate.id === frame.cellId);
    if (!cell || resolveNotebookCellArtifactId(document, cell) !== frame.artifactId) {
      throw new Error(`Storyboard frame ${index + 1} was removed from the notebook. Start a new /goal to make the storyboard again.`);
    }
  }
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
    content = { brief, revision: 1, draft: null, plan, estimate: await estimateShort(engine, plan, { brief, draft: null }), notes: [] };
  } else {
    const timing = shortTiming(brief);
    const authored = shortAuthoredCopy(brief, timing.segmentSeconds);
    const planning = shortPlannerNeeded(brief, authored.segmentSeconds);
    const mentioned = await briefReferences(engine, bookId, notebookId, brief);
    referenceNotes = mentioned.notes;
    const draft: GoalShortDraft = {
      aspectRatio: timing.aspectRatio,
      segmentSeconds: authored.segmentSeconds,
      sourceImages: mentioned.references,
      ...(mentioned.storyboard ? { storyboard: mentioned.storyboard } : {}),
    };
    const notes = [timing.note, authored.note].filter((note): note is string => note !== null);
    if (planning) {
      content = { brief, revision: 1, draft, plan: null, estimate: emptyGoalEstimates(), notes };
    } else {
      const written = shortBriefPlan(brief, authored);
      if (written.note) notes.push(written.note);
      const plan = buildGoalShortPlan({
        aspectRatio: draft.aspectRatio,
        segmentSeconds: draft.segmentSeconds,
        sourceImages: draft.sourceImages,
        storyboard: mentioned.storyboard,
        title: shortTitle(brief, written.frame),
        framePrompt: written.frame,
        beats: written.beats,
      });
      content = { brief, revision: 1, draft, plan, estimate: await estimateShort(engine, plan, { brief, draft }), notes };
    }
  }
  const goalId = uuidv7();
  const cell = await createGoalShortCell(engine, notebookId, goalId, content);
  const timestamp = new Date().toISOString();
  const goal: GoalRecord = {
    goalId, bookId, notebookId, cellId: cell.id, requestId: input.requestId, status: content.plan ? "review" : "planning", planVersion: content.plan?.version ?? 5,
    stage: shortStoryboardOf(content.plan ?? content.draft) ? "storyboards" : "frame", stages: {}, chainId: null, planningJobId: null, clipIds: [], trackId: null,
    assembly: null, error: null, dismissedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  if (referenceNotes.length > 0) {
    content = { ...content, notes: [...content.notes, ...renderReferenceNotes(readNotebook(engine, notebookId), referenceNotes)] };
    await writeGoalShortContent(engine, goal, content);
  }
  const saved = saveGoal(engine, goal);
  return content.plan ? saved : queueShortPlanning(engine, saved);
}

async function rewrittenShortPrompt(goal: GoalRecord, stage: GoalGenerationStage, index: number, feedback: string, revision: number): Promise<string> {
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

function withStagePrompt(plan: GoalShortPlan, stage: GoalGenerationStage, index: number, prompt: string): unknown {
  if (stage === "frame") return { ...plan, frame: { ...plan.frame, prompt } };
  if (stage === "videos") return { ...plan, segments: plan.segments.map((segment, position) => position === index ? { ...segment, prompt } : segment) };
  const storyboard = shortStoryboardOf(plan);
  if (plan.version !== 5 || !storyboard) return plan;
  return { ...plan, storyboard: { ...storyboard, frames: storyboard.frames.map((frame) => frame.index === index ? { ...frame, prompt } : frame) } };
}

async function revisedShortContent(engine: Engine, goal: GoalRecord, content: GoalShortContent & { plan: GoalShortPlan }, stage: GoalGenerationStage, index: number, feedback: string) {
  const prompt = await rewrittenShortPrompt(goal, stage, index, feedback, content.revision);
  const plan = goalShortPlanSchema.parse(withStagePrompt(content.plan, stage, index, prompt));
  const next = { ...content, plan, estimate: await estimateShort(engine, plan, content), revision: content.revision + 1 };
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

async function ensureShortSpace(engine: Engine, goal: GoalRecord, stage: GoalGenerationStage, count: number): Promise<void> {
  const placed = await mutateNotebook(engine, goal.notebookId, "goal_stage_space", (document) => {
    if (NOTEBOOK_GRID_CAPACITY - notebookOccupiedSlots(document.cells).length < 2 * count) {
      throw new Error(count === 1 ? "The notebook needs two empty cells for each frame or clip" : `The notebook needs ${2 * count} empty cells to clean the storyboard`);
    }
    return arrangeGoalNotebook(document, { generators: count, images: stage === "videos" ? 0 : count, videos: stage === "videos" ? count : 0 });
  });
  if (!placed.ok) throw new Error(placed.error.message);
}

function approveOutOfOrder(goal: GoalRecord, plan: GoalShortPlan, active: GoalGenerationStage, requested: GoalGenerationStage): string {
  if (active === "storyboards") return STORYBOARD_FIRST;
  if (requested === "storyboards") {
    return shortStoryboardOf(plan) ? "The storyboard is clean. Regenerate, revise or select a storyboard frame instead." : "This short has no storyboard.";
  }
  if (active === "frame") return selectedOutput(goal, "frame", 0) ? "Approve the frame again before the clips." : "Make the frame before the clips: approve the frame first.";
  return "The frame is made. Regenerate or revise it, or approve the next clip.";
}

function approvedTarget(goal: GoalRecord, plan: GoalShortPlan, args: GoalArgs): ShortTarget {
  const active = activeGoalStage(goal);
  const current = active === "storyboards" && shortStoryboardClean(goal, plan) ? "frame" : active;
  if (args.stage !== undefined) {
    const requested = stageSchema.parse(args.stage);
    if (requested !== current) throw new Error(approveOutOfOrder(goal, plan, current, requested));
  }
  if (current === "storyboards") {
    const missing = shortStoryboardOf(plan)!.frames.filter((frame) => !selectedOutput(goal, "storyboards", frame.index)).map((frame) => frame.index);
    return { stage: "storyboards", indexes: missing };
  }
  if (current === "frame") return { stage: "frame", indexes: [0] };
  const index = nextShortSegment(goal, plan);
  if (index === null) throw new Error("Every segment of this short is generated. Finish it, regenerate a segment or add a beat.");
  return { stage: "videos", indexes: [index] };
}

function shortTarget(engine: Engine, goal: GoalRecord, plan: GoalShortPlan, args: GoalArgs, regenerate: boolean): ShortTarget {
  if (!regenerate) return approvedTarget(goal, plan, args);
  const stage = args.stage !== undefined || args.action === "revise" ? stageSchema.parse(args.stage) : goal.stage === "videos" ? "frame" : null;
  if (!stage) throw new Error("There are no stage outputs to regenerate yet");
  const index = args.index === undefined ? 0 : z.number().int().nonnegative().parse(args.index);
  if (stage === "frame" && index !== 0) throw new Error("A short has one frame");
  if (stage === "videos" && index >= plan.segments.length) throw new Error(`This short has ${plan.segments.length} segments.`);
  if (stage === "storyboards") {
    const count = shortStoryboardOf(plan)?.frames.length ?? 0;
    if (count === 0) throw new Error("This short has no storyboard.");
    if (index >= count) throw new Error(`The storyboard has ${count} frames.`);
  }
  if (!selectedOutput(goal, stage, index) && !(stage === "storyboards" && storyboardFrameFailure(engine, goal, index)?.kind === "failed")) {
    throw new Error("There is no current output to regenerate or revise");
  }
  return { stage, indexes: [index] };
}

function stagePrompt(plan: GoalShortPlan, stage: GoalGenerationStage, index: number): string {
  if (stage === "videos") return plan.segments[index]!.prompt;
  if (stage === "frame") return plan.frame.prompt;
  return shortStoryboardOf(plan)!.frames[index]!.prompt;
}

function stageSteps(goal: GoalRecord, plan: GoalShortPlan, document: NotebookDocument, target: ShortTarget, sourceClip: GoalStageOutput | null): { index: number; step: ChainStep }[] {
  const storyboard = shortStoryboardOf(plan);
  if (target.stage === "storyboards") return target.indexes.map((index) => ({ index, step: compileShortStoryboardStep(storyboard!, index) }));
  const index = target.indexes[0]!;
  if (target.stage === "frame") return [{ index, step: compileShortFrameStep(plan, storyboard ? outputAddress(document, cleanStoryboardFrame(goal)) : null) }];
  return [{
    index,
    step: sourceClip
      ? compileShortContinuationStep(plan, index, outputAddress(document, sourceClip))
      : compileShortClipStep(plan, outputAddress(document, selectedOutput(goal, "frame", 0))),
  }];
}

function assertStageInputs(goal: GoalRecord, plan: GoalShortPlan, target: ShortTarget, document: NotebookDocument): void {
  const storyboard = shortStoryboardOf(plan);
  if (target.stage === "storyboards") assertRawFrames(document, storyboard!, target.indexes);
  if (target.stage === "frame" && storyboard) outputAddress(document, cleanStoryboardFrame(goal));
  if (target.stage === "videos") outputAddress(document, selectedOutput(goal, "frame", 0));
}

export async function startShortStage(engine: Engine, goal: GoalRecord, args: GoalArgs, regenerate: boolean): Promise<GoalRecord> {
  const active = activeGoalStage(goal);
  if (!regenerate && goal.status === "running" && goal.stages[active]?.revision === args.revision) return goal;
  if (!(regenerate ? ["review", "completed", "failed", "interrupted"] : ["review"]).includes(goal.status)) {
    throw new Error("Review the goal before approving, regenerating or revising a stage");
  }
  let content = assertShortRevision(engine, goal, args.revision);
  const target = shortTarget(engine, goal, content.plan, args, regenerate);
  const { stage, indexes } = target;
  const index = indexes[0]!;
  const feedback = args.action === "revise" ? plainFeedback(engine, goal.notebookId, shortFeedbackSchema.parse(args.feedback)) : null;
  if (!process.env.FAL_API_KEY) throw new Error(NO_FAL_KEY);
  if (feedback && !getApiKey("OPENAI_API_KEY")) throw new Error(NO_OPENAI_KEY);
  assertStageInputs(goal, content.plan, target, readNotebook(engine, goal.notebookId));
  const sourceClip = stage === "videos" && index > 0 ? await continuationSource(engine, goal, index) : null;
  await ensureShortSpace(engine, goal, stage, indexes.length);
  if (feedback) content = await revisedShortContent(engine, goal, content, stage, index, feedback);
  const document = readNotebook(engine, goal.notebookId);
  const plan = refreshGoalShortPlan(content.plan, document);
  if (stage === "videos" && index === 0) {
    const frame = selectedOutput(goal, "frame", 0)!;
    const frameAttempt = goal.stages.frame?.attempts?.find((attempt) => attempt.artifactId === frame.artifactId && attempt.fingerprint);
    if (frameAttempt?.fingerprint && frameAttempt.fingerprint !== await shortFingerprint(engine, plan, "frame", 0, stageSource(goal, "frame", 0))) {
      throw new Error("The frame prompt, references or storyboard changed after this frame was made. Regenerate the frame before continuing.");
    }
  }
  const steps = await Promise.all(stageSteps(goal, plan, document, target, sourceClip).map(async ({ index: position, step }) => {
    const source = stageSource(goal, stage, position);
    return { index: position, step, source, fingerprint: await shortFingerprint(engine, plan, stage, position, source) };
  }));
  const previous = goal.stages[stage];
  const attemptCount = previous?.attempts?.length ?? 0;
  const { defs, lookup } = await toolLookup(engine);
  const chain = await preflightAndAccept({
    action: "run", version: 1, book_id: goal.bookId, notebook_id: goal.notebookId,
    request_id: `goal:${goal.goalId}:${stage}:${indexes.join("-")}:${content.revision}:${feedback ? "revise" : regenerate ? "regenerate" : "approve"}:${attemptCount}`,
    steps: steps.map(({ step }) => step),
  }, {
    engine, bookId: goal.bookId, notebookId: goal.notebookId,
    toolSchemas: new Map(defs.map((def) => [def.name, def.schema])), autoApplyTools: new Set(),
    effectForTool: () => "generation", continueOnFailure: stage === "storyboards",
  }, lookup, { actor: "chat" });
  const approvedAt = new Date().toISOString();
  const { finish: _finish, ...stored } = goal;
  return saveGoal(engine, {
    ...(regenerate ? stored : goal),
    stage, chainId: chain.chainId, status: "running", error: null,
    ...(regenerate ? { finish: null, resumeFinish: goal.finish ?? null } : stage === "videos" ? { finish: null } : {}),
    resumeStage: regenerate ? goal.resumeStage ?? active : null,
    resumeStatus: regenerate ? goal.status === "completed" || goal.resumeStatus === "completed" ? "completed" : "review" : null,
    resumeOutputs: regenerate ? previous?.outputs ?? [] : null,
    stages: { ...goal.stages, [stage]: {
      chainId: chain.chainId, revision: content.revision, approvedAt, shotIndexes: indexes,
      outputs: previous?.outputs ?? [], previousChainIds: previous ? [...previous.previousChainIds, previous.chainId] : [],
      attempts: [...(previous?.attempts ?? []), ...steps.map(({ index: position, step, source, fingerprint }) => ({
        stage, index: position, chainId: chain.chainId, stepId: step.id, artifactId: null, cellId: null,
        basePrompt: stagePrompt(plan, stage, position), feedback, fingerprint,
        parentArtifactId: feedback ? selectedOutput(goal, stage, position)?.artifactId ?? null : null,
        frameArtifactId: source, createdAt: approvedAt,
      }))],
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
  if (stage === "storyboards") return saveGoal(engine, storyboardReview(goal, next, plan));
  const clip = stage === "videos" && plan && nextShortSegment(next, plan) === null ? currentShortClip(next) : null;
  const finish = clip ? { status: "review" as const, sourceArtifactId: clip.artifactId, finalArtifactId: null, error: null } : null;
  return saveGoal(engine, { ...next, status: "review", error: null, finish });
}

function lockedSettings(plan: GoalShortPlan) {
  if (plan.version === 5) {
    const { prompt: _prompt, ...frame } = plan.frame;
    return { aspectRatio: plan.aspectRatio, video: plan.video, rules: plan.rules, frame };
  }
  return { aspectRatio: plan.aspectRatio, video: plan.video, rules: plan.rules, frame: { ...plan.frame, prompt: "", references: [] } };
}

function lockedReferences(plan: GoalShortPlan) {
  const reference = (item: GoalShortImageRef) => ({ artifactId: item.artifactId, cellId: item.cellId, objectHash: item.objectHash, slot: item.slot });
  const { title: _title, ...finish } = plan.finish;
  if (plan.version === 5) return { sourceImages: plan.sourceImages.map(reference), finish };
  return {
    character: { ...plan.character, references: plan.character.references.map(reference) },
    frame: plan.frame.references.map(reference),
    finish,
  };
}

function titleFinish(goal: GoalRecord, previous: GoalShortPlan, plan: GoalShortPlan): GoalFinish | null | undefined {
  if (JSON.stringify(previous.finish.title ?? null) === JSON.stringify(plan.finish.title ?? null)) return undefined;
  if (goal.finish?.status === "running") throw new Error(TITLE_WHILE_FINISHING);
  if (goal.finish?.status !== "completed") return undefined;
  const clip = nextShortSegment(goal, plan) === null ? currentShortClip(goal) : null;
  return clip ? { status: "review", sourceArtifactId: clip.artifactId, finalArtifactId: null, error: null } : null;
}

function lockedStoryboard(plan: GoalShortPlan) {
  const storyboard = shortStoryboardOf(plan);
  if (!storyboard) return null;
  return {
    video: { artifactId: storyboard.video.artifactId, cellId: storyboard.video.cellId },
    model: storyboard.model,
    frames: storyboard.frames.map(({ index, atSeconds, aspectRatio, artifactId, cellId, objectHash }) => ({ index, atSeconds, aspectRatio, artifactId, cellId, objectHash })),
  };
}

export async function updateShortGoal(engine: Engine, goal: GoalRecord, args: GoalArgs): Promise<GoalRecord> {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Wait until generation stops before editing the goal");
  const content = assertShortRevision(engine, goal, args.revision);
  const previous = content.plan;
  const plan = goalShortPlanSchema.parse(shortPlanTitleInput(args.plan));
  if (JSON.stringify(lockedReferences(previous)) !== JSON.stringify(lockedReferences(plan))) throw new Error(REFERENCES_LOCKED);
  if (JSON.stringify(lockedStoryboard(previous)) !== JSON.stringify(lockedStoryboard(plan))) throw new Error(STORYBOARD_LOCKED);
  const frameMade = (goal.stages.frame?.outputs.length ?? 0) > 0;
  if (frameMade && JSON.stringify(lockedSettings(previous)) !== JSON.stringify(lockedSettings(plan))) throw new Error(SETTINGS_LOCKED);
  const generated = goal.stages.videos?.outputs.map((output) => output.index) ?? [];
  if (generated.some((index) => plan.segments[index]?.seconds !== previous.segments[index]?.seconds)) throw new Error(SEGMENT_LOCKED);
  if (JSON.stringify(previous) === JSON.stringify(plan)) return goal;
  const generatedPromptChanged = (frameMade && previous.frame.prompt !== plan.frame.prompt)
    || generated.some((index) => previous.segments[index]?.prompt !== plan.segments[index]?.prompt);
  const retitled = titleFinish(goal, previous, plan);
  await writeGoalShortContent(engine, goal, { ...content, plan, estimate: await estimateShort(engine, plan, content), revision: content.revision + 1 });
  const reopened = generatedPromptChanged || retitled !== undefined || plan.segments.length !== previous.segments.length;
  return saveGoal(engine, {
    ...goal,
    ...(reopened ? { status: "review" as const, error: null } : {}),
    ...(generatedPromptChanged ? { finish: null } : retitled !== undefined ? { finish: retitled } : {}),
  });
}

export async function queueShortRealismCheck(engine: Engine, goal: GoalRecord, args: GoalArgs): Promise<GoalRecord> {
  if (args.stage === "storyboards") throw new Error("Check the frame or a clip for AI tells. Storyboard frames come from the video and are not checked.");
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
  const stage = activeGoalStage(goal);
  const run = goal.stages[stage];
  if (run && run.revision !== content.revision) throw new Error("The plan changed after this attempt. Regenerate using the current plan instead of retrying the older request.");
  const plan = refreshGoalShortPlan(content.plan, readNotebook(engine, goal.notebookId));
  for (const attempt of run?.attempts ?? []) {
    if (attempt.chainId !== goal.chainId || !attempt.fingerprint) continue;
    if (attempt.fingerprint !== await shortFingerprint(engine, plan, stage, attempt.index, stageSource(goal, stage, attempt.index))) throw new Error(STALE_RETRY);
  }
  if (!process.env.FAL_API_KEY) throw new Error(NO_FAL_KEY);
  const { lookup } = await toolLookup(engine);
  retryChainRun(engine, goal.chainId, lookup, { continueOnFailure: stage === "storyboards" });
  return saveGoal(engine, { ...goal, status: "running", error: null });
}
