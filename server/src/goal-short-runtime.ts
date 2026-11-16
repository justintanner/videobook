import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import { z } from "zod";
import type { Engine, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile, resolveNotebookCellArtifactId } from "videobook-engine";
import { firstEmptyNotebookGridSlot, notebookGridTag, notebookOccupiedSlots, NOTEBOOK_GRID_CAPACITY } from "videobook-engine/notebook-grid";
import { replaceNotebookMentions, scanNotebookMentions, type NotebookMention } from "videobook-engine/notebook-mentions";
import { getApiKey } from "./api-key.js";
import { getChainRun, preflightAndAccept, retryChainRun, type ChainRunRecord } from "./chain-executor.js";
import type { ChainStep } from "./chain-plan.js";
import { probeVideo } from "./ffmpeg.js";
import {
  buildGoalShortPlan, compileShortClipStep, compileShortContinuationStep, compileShortFrameStep, compileShortReplacementStep, compileShortStoryboardStep, formatShortSeconds,
  goalShortPlanSchema, isLegacyShortDraft, refreshGoalShortPlan, SHORT_STORYBOARD_MODELS, shortPlanTitleInput, shortGenerationSegments, shortRemixOf, shortRemixSourceOf, shortStoryboardOf, shortTiming, storyboardFallbackModel,
  type GoalShortDraft, type GoalShortImageRef, type GoalShortPlan, type ShortRemixSource, type ShortStoryboard, type ShortStoryboardModel, type ShortStoryboardVideo,
} from "./goal-short-plan.js";
import { shortAuthoredCopy, shortBriefPlan, shortPlannerNeeded, shortTitle } from "./goal-short-planner.js";
import { briefMention, renderReferenceNotes, type ReferenceNote } from "./goal-short-references.js";
import { captureStoryboardFrames, videoGoalFrameMoment } from "./goal-short-storyboard.js";
import { buildRemixAnalysis, readRemixPreferences, writeRemixPreferences } from "./goal-remix-analysis.js";
import { prepareShortSource } from "./goal-source-preparation.js";
import { remixPromptFindings, remixRules } from "./goal-remix-model.js";
import { goalBrandingFindings } from "./goal-finish-model.js";
import { goalReferenceHashes } from "./goal-reference-images.js";
import { goalStageAttempts } from "./goal-stills.js";
import { goalGenerationHistory, goalHistoryInputProblem, reviewedGoalOutput, type GoalHistoryEntry } from "./goal-generation-history.js";
import { goalQualityEstimate } from "./goal-quality.js";
import {
  activeGoalStage, createGoalShortCell, emptyGoalEstimates, readGoal, requireGoalShortContent, saveGoal, writeGoalShortContent,
  type GoalEstimate, type GoalEstimates, type GoalFinish, type GoalGenerationStage, type GoalRecord, type GoalShortContent, type GoalStageOutput,
} from "./goal-store.js";
import { goalTitleEstimate, type GoalTitleShort } from "./graphics/suggest.js";
import { assessToolCallEstimate } from "./jobs/cost-estimate-assessment.js";
import { resolveModel } from "./media/descriptor.js";
import { arrangeGoalNotebook } from "./notebook-goal-layout.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { resolveNotebookArtifactReference } from "./notebook-reference-resolver.js";
import { queue } from "./queue.js";

type GoalArgs = Record<string, unknown>;
type ShortReference = Omit<GoalShortImageRef, "slot">;
type ShortTarget = { stage: GoalGenerationStage; indexes: number[] };
type BriefReferences = { references: ShortReference[]; sourceVideo: ShortStoryboardVideo | null; atSeconds: number | null; notes: ReferenceNote[] };
export type StoryboardFrameFailure = { kind: "failed" | "not-run"; message: string; model?: ShortStoryboardModel };

const EXTRA_REFERENCE_LIMIT = 12;
const NO_OPENAI_KEY = "Set OPENAI_API_KEY in Settings to revise with feedback, or edit the prompt and regenerate.";
const REVISE_TIMEOUT_MS = 240_000;
const SETTINGS_LOCKED = "Models, resolution, aspect ratio and rules stay with this short once its frame exists. Start a new /goal to change them.";
const REFERENCES_LOCKED = "The source images stay with this short. Start a new /goal to change them.";
const STORYBOARD_LOCKED = "The storyboard's video and frames stay with this short. Start a new /goal to change them.";
const STORYBOARD_FIRST = "Clean the storyboard first: approve the storyboard stage to remove its on-screen graphics before the frame is made.";
const REPLACEMENT_FIRST = "Replace the character first, then review the twist before making the video.";
const SEGMENT_LOCKED = "A generated segment keeps its place and seconds. Regenerate it, or start a new /goal to change them.";
const TITLE_WHILE_FINISHING = "Wait until finishing stops before changing the burned title.";
const STALE_RETRY = "The references or selected versions changed after this attempt. Regenerate using the current selection instead of retrying the older request.";
const EXTEND_SOURCE_SECONDS = { minimum: 1.625, maximum: 60 };
const PLACEHOLDER_FRAME = "https://videobook.invalid/short-frame.jpg";
const PLACEHOLDER_CLIP = "https://videobook.invalid/short-clip.mp4";
const stageSchema = z.enum(["storyboards", "replacement", "frame", "videos"]);
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

export async function mentionedSourceFrame(
  engine: Engine,
  bookId: string,
  notebookId: string,
  video: ShortStoryboardVideo,
  mention: string,
  atSeconds: number | null,
): Promise<{ remix: ShortRemixSource | null; note: ReferenceNote }> {
  const skipped = (text: string) => ({ remix: null, note: { kind: "text" as const, text } });
  let moment: number | null;
  try {
    moment = await videoGoalFrameMoment(engine, bookId, video.artifactId, atSeconds);
  } catch {
    return skipped(`${mention} is a video, but its frames could not be read, so it was skipped.`);
  }
  if (moment === null) {
    return skipped(atSeconds === null
      ? `${mention} is a video, but no usable source frame was found, so it was skipped.`
      : `${mention} is a video, but it has no frame at ${formatShortSeconds(atSeconds)} s, so it was skipped.`);
  }
  try {
    const frames = await captureStoryboardFrames(engine, notebookId, { artifactId: video.artifactId, ...(video.cellId ? { cellId: video.cellId } : {}) }, [moment], true);
    const { index: _index, requestedSeconds: _requested, aspectRatio: _aspect, width: _width, height: _height, ...frame } = frames[0]!;
    return {
      remix: { video, frame },
      note: { kind: "source-frame", mention, frames: [{ cellId: frame.cellId, atSeconds: frame.atSeconds }] },
    };
  } catch (error) {
    return skipped(`${mention} is a video, but it was skipped. ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function briefReferences(engine: Engine, notebookId: string, brief: string): Promise<BriefReferences> {
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
      notes.push({ kind: "text", text: `${mention.raw} is another video and was skipped: the source frame comes from the first video the brief mentions.` });
      continue;
    }
    video = { found: found.video, mention };
    notes.push(null);
  }
  return { references, sourceVideo: video?.found ?? null, atSeconds: video ? mentionTimestamp(brief, video.mention) : null, notes: notes.filter((note): note is ReferenceNote => note !== null) };
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
  if (clip && shortRemixOf(plan)) return [];
  if (plan.version === 5) return plan.sourceImages.map((reference) => reference.artifactId);
  return (clip ? plan.character.references : [...plan.character.references, ...plan.frame.references]).map((reference) => reference.artifactId);
}

export async function estimateShort(engine: Engine, plan: GoalShortPlan, short: GoalTitleShort): Promise<GoalEstimates> {
  const remix = shortRemixOf(plan);
  const storyboard = shortStoryboardOf(plan);
  const firstFrame = storyboard?.frames[0] ?? null;
  const frameIds = [...shortImageIds(plan, false), ...(firstFrame ? [firstFrame.artifactId] : [])];
  const clipIds = shortImageIds(plan, true);
  const clipRefs: Record<string, string[]> = remix
    ? { video: [plan.version === 5 ? plan.analysis?.recipe.referenceArtifactId ?? remix.video.artifactId : remix.video.artifactId], image: [PLACEHOLDER_FRAME] }
    : { first_frame: [PLACEHOLDER_FRAME], image: clipIds.length > 0 ? clipIds : [PLACEHOLDER_FRAME] };
  const storyboardFrames = storyboard
    ? await Promise.all(storyboard.frames.map((frame) => priced(engine, compileShortStoryboardStep(storyboard, frame.index), { image: [frame.artifactId] })))
    : [];
  const fallback = storyboard ? storyboardFallbackModel(storyboard.model) : null;
  const storyboardFallbackFrames = storyboard && fallback
    ? await Promise.all(storyboard.frames.map((frame) => priced(engine, compileShortStoryboardStep(storyboard, frame.index, fallback), { image: [frame.artifactId] })))
    : [];
  const replacement = remix ? await priced(engine, compileShortReplacementStep(plan), { image: [...shortImageIds(plan, false), remix.frame.artifactId] }) : null;
  const frame = await priced(engine, compileShortFrameStep(plan, remix ? PLACEHOLDER_FRAME : firstFrame?.address ?? null), remix ? { image: [PLACEHOLDER_FRAME] } : frameIds.length > 0 ? { image: frameIds } : {});
  const segments = await Promise.all(shortGenerationSegments(plan).map((_, index) => index === 0
    ? priced(engine, compileShortClipStep(plan, PLACEHOLDER_FRAME), clipRefs)
    : priced(engine, compileShortContinuationStep(plan, index, PLACEHOLDER_CLIP), { video: [PLACEHOLDER_CLIP] })));
  const storyboards = summed(storyboardFrames);
  const videos = summed(segments);
  const title = goalTitleEstimate({ brief: short.brief, draft: short.draft, plan });
  const quality = plan.version === 5 && plan.analysis?.recipe.outputAssertions ? goalQualityEstimate(plan) : null;
  return { frame, storyboards, videos, total: summed([storyboards, ...(replacement ? [replacement] : []), frame, videos,
    ...(quality && plan.version === 5 && plan.analysis?.preferences.semanticChecks ? [quality] : [])]), segments, ...(replacement ? { replacement } : {}), ...(quality ? { quality } : {}), ...(storyboard ? { storyboardFrames, storyboardFallbackFrames } : {}), title };
}

export async function shortFingerprint(
  engine: Engine, plan: GoalShortPlan, stage: GoalGenerationStage, index: number, sourceArtifactId: string | null, model?: ShortStoryboardModel,
): Promise<string> {
  const storyboard = shortStoryboardOf(plan);
  const remix = shortRemixOf(plan);
  if (stage === "replacement") {
    if (!remix) throw new Error("This short has no character replacement step.");
    return JSON.stringify({ settings: remix.replacement,
      ...(plan.version === 5 && plan.analysis ? { policy: { character: plan.analysis.intent.character, cleanup: plan.analysis.intent.cleanup } } : {}),
      references: await goalReferenceHashes(engine, [...shortImageIds(plan, false), remix.frame.artifactId]) });
  }
  if (stage === "storyboards") {
    const frame = storyboard?.frames[index];
    return JSON.stringify({
      prompt: frame?.prompt ?? null,
      model: model ?? storyboard?.model ?? null,
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
      references: await goalReferenceHashes(engine, remix ? [sourceArtifactId ?? remix.frame.artifactId] : shortImageIds(plan, false)),
      ...(remix ? { replacement: sourceArtifactId } : {}),
      ...(storyboard ? { storyboardFrame: sourceArtifactId } : {}),
    });
  }
  return JSON.stringify({
    prompt: shortGenerationSegments(plan)[index]?.prompt ?? null,
    seconds: shortGenerationSegments(plan)[index]?.seconds ?? null,
    ...(plan.version === 5 && plan.analysis?.recipe.assembly ? { assembly: plan.analysis.recipe.assembly, context: plan.segments } : {}),
    rules: { video: plan.rules.video, silence: plan.rules.silence },
    settings: { ...plan.video, aspectRatio: plan.aspectRatio },
    references: await goalReferenceHashes(engine, shortImageIds(plan, true)),
    sourceArtifactId,
    ...(remix && index === 0 ? { videoReferences: await goalReferenceHashes(engine, [remix.video.artifactId,
      ...(plan.version === 5 && plan.analysis?.recipe.referenceArtifactId ? [plan.analysis.recipe.referenceArtifactId] : []), ...(sourceArtifactId ? [sourceArtifactId] : [])]) } : {}),
  });
}

function selectedOutput(goal: GoalRecord, stage: GoalGenerationStage, index: number): GoalStageOutput | undefined {
  return goal.stages[stage]?.outputs.find((output) => output.index === index);
}

function stageSource(goal: GoalRecord, stage: GoalGenerationStage, index: number): string | null {
  if (stage === "storyboards" || stage === "replacement") return null;
  if (stage === "frame") return selectedOutput(goal, "replacement", 0)?.artifactId ?? selectedOutput(goal, "storyboards", 0)?.artifactId ?? null;
  return (index === 0 ? selectedOutput(goal, "frame", 0) : selectedOutput(goal, "videos", index - 1))?.artifactId ?? null;
}

function madeFromStaleSource(goal: GoalRecord, stage: "frame" | "videos", index: number): boolean {
  const output = selectedOutput(goal, stage, index);
  if (!output) return false;
  const attempt = reviewedGoalOutput(goal, stage, index, output.artifactId) ?? goal.stages[stage]?.attempts?.find((candidate) => candidate.index === index && candidate.artifactId === output.artifactId);
  return Boolean(attempt?.frameArtifactId && attempt.frameArtifactId !== stageSource(goal, stage, index));
}

export function shortFrameStale(goal: GoalRecord): boolean {
  return madeFromStaleSource(goal, "frame", 0);
}

export function shortSegmentStale(goal: GoalRecord, index: number): boolean {
  if (!selectedOutput(goal, "videos", index)) return false;
  if (shortFrameStale(goal)) return true;
  if (index > 0 && shortSegmentStale(goal, index - 1)) return true;
  return madeFromStaleSource(goal, "videos", index);
}

function assertStageKey(plan: GoalShortPlan, stage: GoalGenerationStage, model?: ShortStoryboardModel): void {
  const storyboard = stage === "storyboards" ? shortStoryboardOf(plan) : null;
  const cleanup = storyboard ? model ?? storyboard.model : null;
  const key = cleanup && resolveModel(cleanup).provider === "kie" ? "KIE_API_KEY" : "FAL_API_KEY";
  if (!process.env[key]) throw new Error(`Set ${key} in Settings before generating this stage`);
}

function cleanupModel(plan: GoalShortPlan, stage: GoalGenerationStage, args: GoalArgs, regenerate: boolean): ShortStoryboardModel | undefined {
  const storyboard = stage === "storyboards" ? shortStoryboardOf(plan) : null;
  if (args.model === undefined) return storyboard?.model;
  if (!storyboard || !regenerate) throw new Error("Choose a clean-up model only when you regenerate or revise one storyboard frame.");
  return z.enum(SHORT_STORYBOARD_MODELS).parse(args.model);
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
  const chain = attempt?.chainId ? getChainRun(engine, attempt.chainId) : null;
  const step = chain?.steps.find((candidate) => candidate.id === attempt?.stepId);
  if (!chain || !step) return null;
  const model = attempt?.model ? { model: attempt.model } : {};
  if (step.status === "failed") return { kind: "failed", message: step.error ?? "The clean-up failed.", ...model };
  if (selectedOutput(goal, "storyboards", index) || !["interrupted", "skipped", "cancelled", "rejected"].includes(step.status)) return null;
  return { kind: "not-run", message: notRunReason(chain), ...model };
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
  for (let index = 0; index < shortGenerationSegments(plan).length; index += 1) {
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
  const preferences = readRemixPreferences(engine);
  if (input.plan) {
    const plan = goalShortPlanSchema.parse(input.plan);
    const remix = shortRemixOf(plan);
    const draft: GoalShortDraft | null = plan.version === 5 ? {
      aspectRatio: plan.aspectRatio, segmentSeconds: plan.segments.map(segment => segment.seconds), sourceImages: plan.sourceImages.map(({ slot: _slot, ...reference }) => reference),
      ...(remix ? { remix: { video: remix.video, frame: remix.frame } } : {}), ...(plan.storyboard ? { storyboard: plan.storyboard } : {}),
      analysisRequest: { preferences: plan.analysis?.preferences ?? preferences, sourceVideo: remix?.video ?? null, atSeconds: remix?.frame.atSeconds ?? null },
    } : null;
    const analyzed = plan.version === 5 && !remix ? { ...plan, analysis: await buildRemixAnalysis(engine, {
      brief, totalSeconds: plan.segments.reduce((sum, segment) => sum + segment.seconds, 0), notebookId,
      preferences: plan.analysis?.preferences ?? preferences, source: null,
    }) } : plan;
    content = { brief, revision: 1, draft, plan: analyzed, estimate: await estimateShort(engine, analyzed, { brief, draft }), notes: [] };
  } else {
    const timing = shortTiming(brief);
    const mentioned = await briefReferences(engine, notebookId, brief);
    const authored = shortAuthoredCopy(brief, timing.segmentSeconds, Boolean(mentioned.sourceVideo));
    const planning = mentioned.sourceVideo !== null || shortPlannerNeeded(brief, authored.segmentSeconds, false);
    referenceNotes = mentioned.notes;
    const draft: GoalShortDraft = {
      aspectRatio: timing.aspectRatio,
      segmentSeconds: authored.segmentSeconds,
      sourceImages: mentioned.references,
      analysisRequest: { preferences, sourceVideo: mentioned.sourceVideo, atSeconds: mentioned.atSeconds },
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
        replacementPrompt: written.replacement,
        title: shortTitle(brief, written.frame),
        framePrompt: written.frame,
        beats: written.beats,
        analysis: await buildRemixAnalysis(engine, { brief, totalSeconds: authored.segmentSeconds.reduce((sum, seconds) => sum + seconds, 0), notebookId, preferences, source: null }),
      });
      content = { brief, revision: 1, draft, plan, estimate: await estimateShort(engine, plan, { brief, draft }), notes };
    }
  }
  const goalId = uuidv7();
  const cell = await createGoalShortCell(engine, notebookId, goalId, content);
  const timestamp = new Date().toISOString();
  const pendingSource = content.draft && !isLegacyShortDraft(content.draft) ? content.draft.analysisRequest?.sourceVideo : null;
  const goal: GoalRecord = {
    goalId, bookId, notebookId, cellId: cell.id, requestId: input.requestId, status: content.plan && !pendingSource ? "review" : "planning", planVersion: content.plan?.version ?? 5,
    stage: pendingSource || shortRemixSourceOf(content.plan ?? content.draft) ? "replacement" : shortStoryboardOf(content.plan ?? content.draft) ? "storyboards" : "frame", stages: {}, chainId: null, planningJobId: null, clipIds: [], trackId: null,
    assembly: null, error: null, dismissedAt: null, createdAt: timestamp, updatedAt: timestamp,
  };
  if (referenceNotes.length > 0) {
    content = { ...content, notes: [...content.notes, ...renderReferenceNotes(readNotebook(engine, notebookId), referenceNotes)] };
    await writeGoalShortContent(engine, goal, content);
  }
  const saved = saveGoal(engine, goal);
  return saved.status === "review" ? saved : queueShortPlanning(engine, saved);
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
  if (stage === "replacement" && plan.version === 5 && plan.remix) return { ...plan, remix: { ...plan.remix, replacement: { ...plan.remix.replacement, prompt } } };
  if (stage === "frame") return { ...plan, frame: { ...plan.frame, prompt } };
  if (stage === "videos" && plan.version === 5 && plan.analysis?.recipe.assembly) return { ...plan, analysis: { ...plan.analysis, intent: { ...plan.analysis.intent, actionDescription: prompt } } };
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

export async function shortFinishSource(engine: Engine, goal: GoalRecord): Promise<string> {
  const plan = requireGoalShortContent(engine, goal).plan;
  const clip = plan?.version === 5 && plan.analysis?.recipe.assembly ? selectedOutput(goal, "videos", 0) : currentShortClip(goal);
  if (!plan || !clip || nextShortSegment(goal, plan) !== null) throw new Error("Generate every segment of the short before finishing it.");
  if (shortRemixOf(plan)) await assertShortUpstream(engine, goal, plan, "videos");
  if (plan.version === 5 && plan.analysis) {
    await assertRemixPreflight(engine, plan);
    const attempt = reviewedGoalOutput(goal, "videos", clip.index, clip.artifactId) ?? goal.stages.videos?.attempts?.find(candidate => candidate.artifactId === clip.artifactId && candidate.fingerprint);
    if (attempt && "mediaHash" in attempt && (await goalReferenceHashes(engine, [clip.artifactId]))[0]?.objectHash !== attempt.mediaHash) throw new Error("The reviewed take changed. Review its current media before finishing.");
    if (attempt?.fingerprint && attempt.fingerprint !== await shortFingerprint(engine, plan, "videos", clip.index, stageSource(goal, "videos", clip.index))) {
      throw new Error("The video prompt, timing or references changed. Review a compatible take before finishing.");
    }
  }
  return clip.artifactId;
}

async function assertShortUpstream(engine: Engine, goal: GoalRecord, plan: GoalShortPlan, stage: GoalGenerationStage): Promise<void> {
  for (const earlier of stage === "videos" ? ["replacement", "frame"] as const : stage === "frame" ? ["replacement"] as const : []) {
    const review = reviewedGoalOutput(goal, earlier, 0, selectedOutput(goal, earlier, 0)?.artifactId);
    if (review && (await goalReferenceHashes(engine, [review.artifactId]))[0]?.objectHash !== review.mediaHash) throw new Error("A reviewed upstream image changed. Review its current media before continuing.");
  }
  if ((stage === "frame" || stage === "videos") && shortRemixOf(plan)) {
    const replacement = selectedOutput(goal, "replacement", 0);
    const attempt = reviewedGoalOutput(goal, "replacement", 0, replacement?.artifactId) ?? goal.stages.replacement?.attempts?.find(candidate => candidate.artifactId === replacement?.artifactId && candidate.fingerprint);
    if (!replacement || (attempt?.fingerprint && attempt.fingerprint !== await shortFingerprint(engine, plan, "replacement", 0, null))) {
      throw new Error("The character replacement prompt or references changed. Regenerate the replacement before continuing.");
    }
  }
  if (stage !== "videos") return;
  const frame = selectedOutput(goal, "frame", 0);
  const attempt = reviewedGoalOutput(goal, "frame", 0, frame?.artifactId) ?? goal.stages.frame?.attempts?.find(candidate => candidate.artifactId === frame?.artifactId && candidate.fingerprint);
  if (!frame || (attempt?.fingerprint && attempt.fingerprint !== await shortFingerprint(engine, plan, "frame", 0, stageSource(goal, "frame", 0)))) {
    throw new Error(shortRemixOf(plan)
      ? "The twist prompt or character replacement changed. Regenerate the twist before continuing."
      : "The frame prompt, references or storyboard changed after this frame was made. Regenerate the frame before continuing.");
  }
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
  if (active === "replacement") return REPLACEMENT_FIRST;
  if (requested === "replacement") return "The character is replaced. Regenerate or revise the replacement instead.";
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
  if (current === "frame" || current === "replacement") return { stage: current, indexes: [0] };
  const index = nextShortSegment(goal, plan);
  if (index === null) throw new Error("Every segment of this short is generated. Finish it, regenerate a segment or add a beat.");
  return { stage: "videos", indexes: [index] };
}

function shortTarget(engine: Engine, goal: GoalRecord, plan: GoalShortPlan, args: GoalArgs, regenerate: boolean): ShortTarget {
  if (!regenerate) return approvedTarget(goal, plan, args);
  const stage = args.stage !== undefined || args.action === "revise" ? stageSchema.parse(args.stage) : goal.stage === "videos" ? "frame" : null;
  if (!stage) throw new Error("There are no stage outputs to regenerate yet");
  const index = args.index === undefined ? 0 : z.number().int().nonnegative().parse(args.index);
  if (stage === "replacement" && (!shortRemixOf(plan) || index !== 0)) throw new Error("This short has no character replacement at that index.");
  if (stage === "frame" && index !== 0) throw new Error("A short has one frame");
  if (stage === "videos" && index >= shortGenerationSegments(plan).length) throw new Error(`This short has ${shortGenerationSegments(plan).length} generated clips.`);
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
  if (stage === "replacement") return shortRemixOf(plan)!.replacement.prompt;
  if (stage === "videos") return shortGenerationSegments(plan)[index]!.prompt;
  if (stage === "frame") return plan.frame.prompt;
  return shortStoryboardOf(plan)!.frames[index]!.prompt;
}

function stageSteps(
  goal: GoalRecord, plan: GoalShortPlan, document: NotebookDocument, target: ShortTarget, sourceClip: GoalStageOutput | null, model?: ShortStoryboardModel,
): { index: number; step: ChainStep }[] {
  const storyboard = shortStoryboardOf(plan);
  const remix = shortRemixOf(plan);
  if (target.stage === "replacement") return [{ index: 0, step: compileShortReplacementStep(plan) }];
  if (target.stage === "storyboards") return target.indexes.map((index) => ({ index, step: compileShortStoryboardStep(storyboard!, index, model) }));
  const index = target.indexes[0]!;
  if (target.stage === "frame") return [{ index, step: compileShortFrameStep(plan, remix ? outputAddress(document, selectedOutput(goal, "replacement", 0)) : storyboard ? outputAddress(document, cleanStoryboardFrame(goal)) : null) }];
  return [{
    index,
    step: sourceClip
      ? compileShortContinuationStep(plan, index, outputAddress(document, sourceClip))
      : compileShortClipStep(plan, outputAddress(document, selectedOutput(goal, "frame", 0))),
  }];
}

function assertStageInputs(goal: GoalRecord, plan: GoalShortPlan, target: ShortTarget, document: NotebookDocument): void {
  const remix = shortRemixOf(plan);
  if (target.stage === "replacement" && remix) {
    const cell = document.cells.find(candidate => candidate.id === remix.frame.cellId);
    if (!cell || resolveNotebookCellArtifactId(document, cell) !== remix.frame.artifactId) throw new Error("The extracted source frame changed or was removed. Start a new /goal.");
  }
  if (target.stage === "frame" && remix) {
    if (!selectedOutput(goal, "replacement", 0)) throw new Error(REPLACEMENT_FIRST);
    outputAddress(document, selectedOutput(goal, "replacement", 0));
  }
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
  const model = cleanupModel(content.plan, stage, args, regenerate);
  if (!regenerate && content.plan.version === 5 && content.plan.analysis) {
    await assertRemixPreflight(engine, content.plan);
    const reusable = (await reviewedShortCandidates(engine, goal, content.plan)).find(entry => entry.stage === stage && entry.index === index);
    if (reusable) return selectShortVersion(engine, goal, { action: "adopt", revision: content.revision, stage, index,
      artifact_id: reusable.artifactId, media_hash: reusable.mediaHash, confirmed: true });
  }
  assertStageKey(content.plan, stage, model);
  if (feedback && !getApiKey("OPENAI_API_KEY")) throw new Error(NO_OPENAI_KEY);
  assertStageInputs(goal, content.plan, target, readNotebook(engine, goal.notebookId));
  const sourceClip = stage === "videos" && index > 0 ? await continuationSource(engine, goal, index) : null;
  await ensureShortSpace(engine, goal, stage, indexes.length);
  if (feedback) content = await revisedShortContent(engine, goal, content, stage, index, feedback);
  const document = readNotebook(engine, goal.notebookId);
  const plan = refreshGoalShortPlan(content.plan, document);
  await assertRemixPreflight(engine, plan);
  await assertShortUpstream(engine, goal, plan, stage);
  goal = saveGoal(engine, await rememberUpstreamReviews(engine, goal, plan, stage));
  const steps = await Promise.all(stageSteps(goal, plan, document, target, sourceClip, model).map(async ({ index: position, step }) => {
    const source = stageSource(goal, stage, position);
    return { index: position, step, source, fingerprint: await shortFingerprint(engine, plan, stage, position, source, model) };
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
  }, lookup, { actor: "chat", goalOrigins: Object.fromEntries(steps.map(({ index: position, step, source, fingerprint }) => [step.id, {
    version: 1, goalId: goal.goalId, stage, index: position, revision: content.revision, fingerprint,
    basePrompt: stagePrompt(plan, stage, position), frameArtifactId: source,
    ...(stage === "videos" ? { transcribe: false as const } : {}),
    source: plan.version === 5 && plan.analysis?.source ? { artifactId: plan.analysis.source.artifactId, mediaHash: plan.analysis.source.mediaHash } : null,
  }])) });
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
      outputs: previous?.outputs ?? [], previousChainIds: previous ? [...previous.previousChainIds, ...(previous.chainId ? [previous.chainId] : [])] : [],
      attempts: [...(previous?.attempts ?? []), ...steps.map(({ index: position, step, source, fingerprint }) => ({
        stage, index: position, chainId: chain.chainId, stepId: step.id, artifactId: null, cellId: null,
        basePrompt: stagePrompt(plan, stage, position), feedback, fingerprint,
        parentArtifactId: feedback ? selectedOutput(goal, stage, position)?.artifactId ?? null : null,
        frameArtifactId: source, ...(model ? { model } : {}), createdAt: approvedAt,
      }))],
    } },
  });
}

async function assertRemixPreflight(engine: Engine, plan: GoalShortPlan): Promise<void> {
  if (plan.version !== 5 || !plan.analysis) return;
  const { analysis } = plan;
  const prompts = [plan.frame.prompt, plan.remix?.replacement.prompt ?? "", ...plan.segments.map(segment => segment.prompt), ...shortGenerationSegments(plan).map(segment => segment.prompt), ...Object.values(plan.rules)];
  const errors = [...analysis.findings.filter(finding => finding.severity === "error" && !finding.code.startsWith("conflicting-")), ...remixPromptFindings(analysis, prompts)];
  if (errors.length) throw new Error(errors.map(finding => finding.text).join(" "));
  const references = await goalReferenceHashes(engine, [...plan.sourceImages.map(reference => reference.artifactId), ...(analysis.source ? [analysis.source.artifactId] : [])]);
  if (references.some(reference => reference.objectHash === null)) throw new Error("An analyzed reference is missing. Restore it or analyze the goal again.");
  if (analysis.source && references.at(-1)?.objectHash !== analysis.source.mediaHash) throw new Error("The source video changed after initial analysis. Analyze the goal again before generating.");
  if (plan.sourceImages.some((reference, index) => references[index]?.objectHash !== reference.objectHash)) throw new Error("A source image changed after initial analysis. Review its current version before generating.");
  if (analysis.source && (!analysis.recipe.cleanupConfirmed || !analysis.recipe.preparedArtifactId
    || analysis.recipe.cleanupReviewedHash !== analysis.recipe.preparedMediaHash)) {
    throw new Error("Prepare and review the source graphics before generating, or explicitly choose to keep them.");
  }
  if (analysis.recipe.preparedArtifactId) {
    const [prepared] = await goalReferenceHashes(engine, [analysis.recipe.preparedArtifactId]);
    if (prepared?.objectHash !== analysis.recipe.preparedMediaHash) throw new Error("The reviewed source copy changed. Prepare it again before generating.");
  }
  if (analysis.source) {
    const [frame] = await goalReferenceHashes(engine, [plan.remix?.frame.artifactId ?? ""]);
    if (frame?.artifactId !== analysis.recipe.preparedFrameArtifactId || !frame?.objectHash || frame.objectHash !== analysis.recipe.preparedFrameMediaHash) {
      throw new Error("The source frame changed after preparation. Prepare the source again before generating.");
    }
  }
  if (analysis.recipe.referenceArtifactId) {
    const [reference] = await goalReferenceHashes(engine, [analysis.recipe.referenceArtifactId]);
    if (reference?.objectHash !== analysis.recipe.referenceMediaHash) throw new Error("The prepared source reference changed. Refresh analysis before generating.");
  }
}

async function placeRecoveredTake(engine: Engine, goal: GoalRecord, entry: GoalHistoryEntry): Promise<GoalStageOutput> {
  const artifactId = entry.artifactId!;
  const output: GoalStageOutput = { index: entry.index, artifactId, cellId: entry.cellId, producerCellId: entry.producerCellId, address: entry.address };
  if (output.cellId) return output;
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok || !["video", "image"].includes(artifact.value.kind)) throw new Error("This take has no image or video artifact.");
  const kind = artifact.value.kind === "video" ? "video" : "image";
  const placed = await mutateNotebook(engine, goal.notebookId, "goal_adopt_output", document => {
    const slot = firstEmptyNotebookGridSlot(notebookOccupiedSlots(document.cells));
    if (!slot) throw new Error("The notebook needs one empty cell for the recovered take.");
    const cell = engine.notebooks.createCell({ type: kind, label: artifact.value.label ?? "Recovered take", slot,
      outputArtifactId: artifactId, inputs: { goalId: goal.goalId, recoveredFromGoalId: entry.originGoalId, state: "completed" } });
    output.cellId = cell.id;
    output.address = notebookGridTag(slot);
    return { ...document, cells: [...document.cells, cell] };
  });
  if (!placed.ok) throw new Error(placed.error.message);
  return output;
}

async function rememberReviewedOutput(engine: Engine, goal: GoalRecord, plan: GoalShortPlan, entry: GoalHistoryEntry): Promise<GoalRecord> {
  if (!entry.artifactId || !entry.mediaHash) throw new Error("Review a completed take before adopting it.");
  const { stage, index, artifactId, mediaHash } = entry;
  const review = { stage, index, artifactId, mediaHash, fingerprint: await shortFingerprint(engine, plan, stage, index, stageSource(goal, stage, index)),
    basePrompt: stagePrompt(plan, stage, index), frameArtifactId: stageSource(goal, stage, index), originGoalId: entry.originGoalId,
    ...(entry.generationId ? { generationId: entry.generationId } : {}), reviewedAt: new Date().toISOString() };
  return { ...goal, reviewedOutputs: [...(goal.reviewedOutputs ?? []).filter(item => !(item.stage === stage && item.index === index && item.artifactId === artifactId)), review] };
}

async function rememberUpstreamReviews(engine: Engine, goal: GoalRecord, plan: GoalShortPlan, stage: GoalGenerationStage): Promise<GoalRecord> {
  const upstream: GoalGenerationStage[] = stage === "videos" ? ["replacement", "storyboards", "frame"] : stage === "frame" ? ["replacement", "storyboards"] : [];
  if (!upstream.length) return goal;
  const history = await goalGenerationHistory(engine, goal.notebookId, { goalId: goal.goalId, related: true });
  let next = goal;
  for (const earlier of upstream) for (const output of goal.stages[earlier]?.outputs ?? []) {
    const entry = history.find(item => item.stage === earlier && item.index === output.index && item.artifactId === output.artifactId);
    if (entry?.mediaHash) next = await rememberReviewedOutput(engine, next, plan, entry);
  }
  return next;
}

function contentFingerprint(fingerprint: string): string {
  try {
    return JSON.stringify(JSON.parse(fingerprint), (key, value: unknown) => {
      if (key === "references" || key === "videoReferences") return Array.isArray(value) ? value.map((item: { artifactId?: string; objectHash?: string | null }) => item.objectHash ? { objectHash: item.objectHash } : item) : value;
      return value;
    });
  } catch { return fingerprint; }
}

async function reviewedShortCandidates(engine: Engine, goal: GoalRecord, plan: GoalShortPlan): Promise<GoalHistoryEntry[]> {
  if (plan.version !== 5 || !plan.analysis?.source) return [];
  const history = await goalGenerationHistory(engine, goal.notebookId, { goalId: goal.goalId, related: true, sourceArtifactId: plan.analysis.source.artifactId });
  const source = { artifactId: plan.analysis.source.artifactId, mediaHash: plan.analysis.source.mediaHash };
  const candidates: GoalHistoryEntry[] = [];
  let selected = goal;
  const stages: GoalGenerationStage[] = plan.remix ? ["replacement", "frame"] : ["frame"];
  for (const stage of stages) {
    const fingerprint = contentFingerprint(await shortFingerprint(engine, plan, stage, 0, stageSource(selected, stage, 0)));
    for (const entry of history.filter(value => value.stage === stage && value.index === 0 && value.review && value.mediaHash === value.review.mediaHash && value.status === "completed")) {
      if (contentFingerprint(entry.review!.fingerprint) !== fingerprint || await goalHistoryInputProblem(engine, entry, source)) continue;
      candidates.push(entry);
      if (!selectedOutput(selected, stage, 0)) selected = { ...selected, stages: { ...selected.stages, [stage]: {
        chainId: null, revision: 0, approvedAt: entry.review!.reviewedAt, shotIndexes: [0], previousChainIds: [],
        outputs: [{ index: 0, artifactId: entry.artifactId!, cellId: entry.cellId, producerCellId: entry.producerCellId, address: entry.address }],
      } } };
      break;
    }
  }
  return candidates;
}

export async function annotateShortReuse(engine: Engine, goal: GoalRecord, plan: GoalShortPlan): Promise<GoalShortPlan> {
  if (plan.version !== 5 || !plan.analysis) return plan;
  const candidates = await reviewedShortCandidates(engine, goal, plan);
  return { ...plan, analysis: { ...plan.analysis, history: plan.analysis.history.map(entry => {
    const reusable = candidates.some(candidate => candidate.artifactId === entry.artifactId);
    return { ...entry, reusable, reason: entry.reason ?? (reusable ? null : entry.approved ? "The current prompt, settings or upstream selection differ." : "Review this output before reusing it.") };
  }) } };
}

export async function selectShortVersion(engine: Engine, goal: GoalRecord, args: GoalArgs): Promise<GoalRecord> {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Select a version while reviewing the goal");
  if (goal.finish?.status === "running") throw new Error("Wait until finishing stops before selecting a take.");
  const content = requireGoalShortContent(engine, goal);
  const plan = content.plan;
  if (!plan) throw new Error("Review the goal's plan before selecting a take.");
  const adopting = args.action === "adopt";
  if ((adopting || args.revision !== undefined) && content.revision !== args.revision) {
    throw new Error("The goal changed. Review the current version before approving it.");
  }
  const stage = stageSchema.parse(args.stage);
  const index = z.number().int().nonnegative().parse(args.index);
  const artifactId = z.string().uuid().parse(args.artifact_id);
  const run = goal.stages[stage];
  const ownAttempt = goalStageAttempts(goal, stage).find(item => item.index === index && item.artifactId === artifactId);
  const history = await goalGenerationHistory(engine, goal.notebookId, { goalId: goal.goalId, related: adopting });
  const entry = history.find(item => item.stage === stage && item.index === index && item.artifactId === artifactId);
  if (!entry?.mediaHash || (!adopting && (!run || !ownAttempt || entry.status !== "completed"))) throw new Error("Choose a completed goal version, or adopt a recovered take after review.");
  if (adopting && (args.confirmed !== true || args.media_hash !== entry.mediaHash)) throw new Error("Confirm that you reviewed this take for the current brief and provide its current media_hash.");
  if (adopting && !["completed", "cancelled", "interrupted"].includes(entry.status)) throw new Error("Wait for this generation to settle before adopting it.");
  const source = plan.version === 5 && plan.analysis?.source ? { artifactId: plan.analysis.source.artifactId, mediaHash: plan.analysis.source.mediaHash } : null;
  const problem = await goalHistoryInputProblem(engine, entry, source);
  if (problem) throw new Error(problem);
  if (stage === "videos" && index >= shortGenerationSegments(plan).length || stage !== "videos" && stage !== "storyboards" && index !== 0) throw new Error("This output has no matching stage in the current plan.");
  const output = await placeRecoveredTake(engine, goal, entry);
  const changed = selectedOutput(goal, stage, index)?.artifactId !== artifactId;
  const outputs = [...(run?.outputs ?? []).filter(item => item.index !== index), output].sort((a, b) => a.index - b.index);
  const attempt = { stage, index, artifactId, cellId: output.cellId, chainId: entry.chainId, stepId: entry.stepId, basePrompt: entry.basePrompt,
    ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}), ...(entry.generationId ? { generationId: entry.generationId } : {}),
    originGoalId: entry.originGoalId, frameArtifactId: entry.frameArtifactId, feedback: entry.feedback, parentArtifactId: entry.parentArtifactId, createdAt: entry.createdAt };
  let next: GoalRecord = { ...goal, stages: { ...goal.stages, [stage]: { chainId: null, revision: content.revision, approvedAt: new Date().toISOString(), shotIndexes: [index], previousChainIds: [], ...run,
    attempts: ownAttempt ? run?.attempts ?? [] : [...(run?.attempts ?? []), attempt], outputs } } };
  if (adopting) next = await rememberReviewedOutput(engine, next, plan, entry);
  if (!changed) return saveGoal(engine, next);
  if (stage === "storyboards") return saveGoal(engine, storyboardReview(goal, next, plan));
  if (stage === "replacement") return saveGoal(engine, { ...next, stage: "frame", status: "review", error: null, finish: null, actionWindow: null });
  const clip = stage === "videos" && plan && nextShortSegment(next, plan) === null ? currentShortClip(next) : null;
  const finish = clip ? { status: "review" as const, sourceArtifactId: clip.artifactId, finalArtifactId: null, error: null } : null;
  return saveGoal(engine, { ...next, stage: stage === "frame" ? "videos" : stage, status: "review", error: null, finish, actionWindow: null });
}

function lockedSettings(plan: GoalShortPlan) {
  if (plan.version === 5) {
    const { prompt: _prompt, ...frame } = plan.frame;
    const { prompt: _replacementPrompt, ...replacement } = plan.remix?.replacement ?? {};
    return { aspectRatio: plan.aspectRatio, video: plan.video, rules: plan.rules, frame, ...(plan.remix ? { replacement } : {}) };
  }
  return { aspectRatio: plan.aspectRatio, video: plan.video, rules: plan.rules, frame: { ...plan.frame, prompt: "", references: [] } };
}

function lockedReferences(plan: GoalShortPlan) {
  const reference = (item: GoalShortImageRef) => ({ artifactId: item.artifactId, cellId: item.cellId, objectHash: item.objectHash, slot: item.slot });
  const { title: _title, ...finish } = plan.finish;
  if (plan.version === 5) {
    const remix = plan.remix;
    const source = remix ? { video: { artifactId: remix.video.artifactId, cellId: remix.video.cellId }, frame: { ...remix.frame, address: undefined, label: undefined } } : null;
    return { sourceImages: plan.sourceImages.map(reference), finish, ...(source ? { remix: source } : {}) };
  }
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
    size: storyboard.size ?? null,
    frames: storyboard.frames.map(({ index, atSeconds, aspectRatio, artifactId, cellId, objectHash }) => ({ index, atSeconds, aspectRatio, artifactId, cellId, objectHash })),
  };
}

export async function updateShortGoal(engine: Engine, goal: GoalRecord, args: GoalArgs): Promise<GoalRecord> {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Wait until generation stops before editing the goal");
  const content = assertShortRevision(engine, goal, args.revision);
  const previous = content.plan;
  let plan = goalShortPlanSchema.parse(shortPlanTitleInput(args.plan));
  const analyzed = previous.version === 5 ? previous.analysis : undefined;
  let analysisChanged = false;
  let generationAnalysisChanged = false;
  let finishSettingsChanged = false;
  if (analyzed && plan.version === 5) {
    if (!plan.analysis) throw new Error("Keep the initial analysis with this goal. Start a new goal to change workflows.");
    const editedAnalysis = plan.analysis;
    if (JSON.stringify(plan.analysis.source) !== JSON.stringify(analyzed.source)) throw new Error("Source analysis is read-only. Analyze the goal again to refresh it.");
    for (const key of ["brief", "history", "analyzedAt", "recipe", "findings"] as const) {
      if (JSON.stringify(plan.analysis[key]) !== JSON.stringify(analyzed[key])) throw new Error("The saved analysis evidence is read-only. Edit its settings or refresh analysis.");
    }
    analysisChanged = JSON.stringify(plan.analysis.intent) !== JSON.stringify(analyzed.intent) || JSON.stringify(plan.analysis.preferences) !== JSON.stringify(analyzed.preferences)
      || plan.segments.reduce((sum, segment) => sum + segment.seconds, 0) !== analyzed.recipe.targetSeconds;
    generationAnalysisChanged = (["structure", "character", "cleanup", "action", "actionDescription", "noDialogue"] as const).some(key =>
      JSON.stringify(editedAnalysis.intent[key]) !== JSON.stringify(analyzed.intent[key]))
      || plan.analysis.preferences.cleanupMethod !== analyzed.preferences.cleanupMethod
      || plan.segments.reduce((sum, segment) => sum + segment.seconds, 0) !== analyzed.recipe.targetSeconds;
    finishSettingsChanged = plan.analysis.intent.audio !== analyzed.intent.audio || plan.analysis.preferences.branding !== analyzed.preferences.branding;
    if (finishSettingsChanged && goal.finish?.status === "running") throw new Error("Wait until finishing stops before changing sound or branding.");
    if (analysisChanged) {
      const intent = { ...plan.analysis.intent, origins: { ...plan.analysis.intent.origins } };
      for (const key of ["structure", "character", "audio", "cleanup", "action", "actionDescription", "noDialogue"] as const) {
        if (JSON.stringify(intent[key]) !== JSON.stringify(analyzed.intent[key])) intent.origins[key] = "edited";
      }
      const analysis = generationAnalysisChanged ? await buildRemixAnalysis(engine, {
        brief: content.brief, totalSeconds: plan.segments.reduce((sum, segment) => sum + segment.seconds, 0), notebookId: goal.notebookId,
        preferences: plan.analysis.preferences, source: analyzed.source, intent,
        requestedFrameSeconds: content.draft && !isLegacyShortDraft(content.draft) ? content.draft.analysisRequest?.atSeconds : null,
      }) : { ...plan.analysis, intent };
      analysis.recipe.promptBindings = analyzed.recipe.promptBindings;
      analysis.recipe.branding = analyzed.recipe.branding;
      analysis.recipe.templateId = analyzed.recipe.templateId;
      analysis.recipe.templateRevision = analyzed.recipe.templateRevision;
      analysis.recipe.soundtrack = analyzed.recipe.soundtrack;
      analysis.findings = analysis.findings.filter(value => value.code !== "missing-audio" && value.code !== "finish-branding");
      if (analysis.recipe.branding) analysis.findings.push(...goalBrandingFindings(analysis.recipe.branding, analysis.preferences.branding, analysis.recipe.targetSeconds));
      if (["source", "mix"].includes(intent.audio) && !(analysis.recipe.soundtrack?.hasAudio ?? analysis.source?.hasAudio)) {
        analysis.findings.push({ code: "missing-audio", severity: "review", text: "The selected soundtrack has no audio. Choose generated sound, mute, or another soundtrack." });
      }
      if (analysis.recipe.sourceFrameSeconds === analyzed.recipe.sourceFrameSeconds) {
        if (analysis.intent.cleanup === analyzed.intent.cleanup) {
          for (const key of ["reference", "referenceArtifactId", "referenceMediaHash", "preparedArtifactId", "preparedMediaHash", "preparedFrameArtifactId", "preparedFrameMediaHash", "cleanupReviewedHash", "cleanupConfirmed", "cleanupRegions", "cleanupMethod"] as const) {
            Object.assign(analysis.recipe, { [key]: analyzed.recipe[key] });
          }
        }
      }
      plan = { ...plan, analysis, rules: generationAnalysisChanged ? remixRules(intent) : plan.rules };
    }
  }
  if (JSON.stringify(lockedReferences(previous)) !== JSON.stringify(lockedReferences(plan))) throw new Error(REFERENCES_LOCKED);
  if (JSON.stringify(lockedStoryboard(previous)) !== JSON.stringify(lockedStoryboard(plan))) throw new Error(STORYBOARD_LOCKED);
  const frameMade = (goal.stages.frame?.outputs.length ?? 0) > 0;
  const replacementMade = (goal.stages.replacement?.outputs.length ?? 0) > 0;
  if (!analyzed && (frameMade || replacementMade) && JSON.stringify(lockedSettings(previous)) !== JSON.stringify(lockedSettings(plan))) throw new Error(SETTINGS_LOCKED);
  const generated = goal.stages.videos?.outputs.map((output) => output.index) ?? [];
  if (generated.some((index) => plan.segments[index]?.seconds !== previous.segments[index]?.seconds)) throw new Error(SEGMENT_LOCKED);
  if (JSON.stringify(previous) === JSON.stringify(plan)) return goal;
  if (plan.version === 5 && plan.analysis) {
    const findings = remixPromptFindings(plan.analysis, [plan.frame.prompt, plan.remix?.replacement.prompt ?? "", ...plan.segments.map(segment => segment.prompt), ...shortGenerationSegments(plan).map(segment => segment.prompt), ...Object.values(plan.rules)]);
    plan = { ...plan, analysis: { ...plan.analysis, findings: [...plan.analysis.findings.filter(finding => !finding.code.startsWith("conflicting-")), ...findings] } };
  }
  const generatedPromptChanged = generationAnalysisChanged || (frameMade && previous.frame.prompt !== plan.frame.prompt)
    || (replacementMade && shortRemixOf(previous)?.replacement.prompt !== shortRemixOf(plan)?.replacement.prompt)
    || generated.some((index) => previous.segments[index]?.prompt !== plan.segments[index]?.prompt);
  const retitled = titleFinish(goal, previous, plan);
  const cleanupChanged = analysisChanged && plan.version === 5 && plan.analysis?.intent.cleanup !== analyzed?.intent.cleanup;
  const sourceFrameChanged = analysisChanged && plan.version === 5 && plan.remix && (plan.analysis?.recipe.sourceFrameSeconds !== plan.remix.frame.atSeconds || cleanupChanged);
  const draft = sourceFrameChanged && plan.version === 5 && plan.analysis ? {
    aspectRatio: plan.aspectRatio, segmentSeconds: plan.segments.map(segment => segment.seconds), sourceImages: plan.sourceImages.map(({ slot: _slot, ...reference }) => reference),
    remix: plan.remix ? { video: plan.remix.video, frame: plan.remix.frame } : undefined,
    analysisRequest: { preferences: plan.analysis.preferences, sourceVideo: plan.remix!.video,
      atSeconds: plan.analysis.recipe.sourceFrameSeconds, intent: plan.analysis.intent },
  } : content.draft;
  await writeGoalShortContent(engine, goal, { ...content, draft, plan, estimate: await estimateShort(engine, plan, content), revision: content.revision + 1 });
  if (sourceFrameChanged) return queueShortPlanning(engine, saveGoal(engine, { ...goal, finish: null, preparation: null }));
  const reopened = generatedPromptChanged || finishSettingsChanged || retitled !== undefined || plan.segments.length !== previous.segments.length;
  return saveGoal(engine, {
    ...goal,
    ...(reopened ? { status: "review" as const, error: null } : {}),
    ...(generatedPromptChanged || finishSettingsChanged ? { finish: null } : retitled !== undefined ? { finish: retitled } : {}),
  });
}

export async function reanalyzeShortGoal(engine: Engine, goal: GoalRecord, revision: unknown): Promise<GoalRecord> {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status)) throw new Error("Stop the current work before refreshing analysis. Cancelled goals stay cancelled.");
  const content = assertShortRevision(engine, goal, revision);
  const plan = refreshGoalShortPlan(content.plan, readNotebook(engine, goal.notebookId));
  if (plan.version !== 5) throw new Error("Start a new goal to use initial analysis with this earlier workflow.");
  const hashes = await goalReferenceHashes(engine, plan.sourceImages.map(reference => reference.artifactId));
  const sourceImages = plan.sourceImages.map((reference, index) => {
    const objectHash = hashes[index]?.objectHash;
    if (!objectHash) throw new Error(`The reference ${reference.address} is missing. Restore it before analyzing.`);
    return { ...reference, objectHash };
  });
  const originalRequest = content.draft && !isLegacyShortDraft(content.draft) ? content.draft.analysisRequest : undefined;
  const draft: GoalShortDraft = {
    aspectRatio: plan.aspectRatio, segmentSeconds: plan.segments.map(segment => segment.seconds), sourceImages: sourceImages.map(({ slot: _slot, ...reference }) => reference),
    ...(plan.remix ? { remix: { video: plan.remix.video, frame: plan.remix.frame } } : {}), ...(plan.storyboard ? { storyboard: plan.storyboard } : {}),
    analysisRequest: { preferences: plan.analysis?.preferences ?? readRemixPreferences(engine), sourceVideo: plan.remix?.video ?? null,
      atSeconds: originalRequest?.atSeconds ?? null, ...(plan.analysis ? { intent: plan.analysis.intent } : {}) },
  };
  await writeGoalShortContent(engine, goal, { ...content, draft, plan: { ...plan, sourceImages }, revision: content.revision + 1 });
  return queueShortPlanning(engine, saveGoal(engine, { ...goal, preparation: null }));
}

export function saveShortDefaults(engine: Engine, goal: GoalRecord, revision: unknown): GoalRecord {
  const { plan } = assertShortRevision(engine, goal, revision);
  if (plan.version !== 5 || !plan.analysis) throw new Error("Analyze this goal before saving its defaults.");
  const { preferences, intent } = plan.analysis;
  writeRemixPreferences(engine, { ...preferences, structure: intent.structure, character: intent.character, audio: intent.audio, cleanup: intent.cleanup, cleanupMethod: plan.analysis.recipe.cleanupMethod });
  return goal;
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
  if (goal.preparation?.status === "failed" && content.plan?.version === 5 && content.plan.analysis) {
    return prepareShortSource(engine, goal, content.revision, { confirmed: true,
      regions: content.plan.analysis.recipe.cleanupRegions, method: content.plan.analysis.recipe.cleanupMethod,
      ...(goal.preparation.artifactId ? { artifactId: goal.preparation.artifactId, mediaHash: goal.preparation.mediaHash } : {}),
    });
  }
  if (!content.plan) return queueShortPlanning(engine, goal);
  if (!goal.chainId) throw new Error("There is no generation to retry. Approve the current stage.");
  const stage = activeGoalStage(goal);
  const run = goal.stages[stage];
  if (run && run.revision !== content.revision) throw new Error("The plan changed after this attempt. Regenerate using the current plan instead of retrying the older request.");
  const plan = refreshGoalShortPlan(content.plan, readNotebook(engine, goal.notebookId));
  const step = getChainRun(engine, goal.chainId)?.steps.find(candidate => candidate.id === "clip1");
  const refs = z.record(z.string(), z.array(z.string())).safeParse(step?.params.refs);
  const repairClip = stage === "videos" && run?.shotIndexes.length === 1 && run.shotIndexes[0] === 0
    && !selectedOutput(goal, "videos", 0) && step?.tool === "generate_video" && refs.success
    && Boolean(refs.data.first_frame?.length) && !["image", "video", "audio"].some(role => refs.data[role]?.length);
  for (const attempt of run?.attempts ?? []) {
    if (attempt.chainId !== goal.chainId || !attempt.fingerprint) continue;
    const fingerprint = await shortFingerprint(engine, plan, stage, attempt.index, stageSource(goal, stage, attempt.index), attempt.model);
    if (attempt.fingerprint === fingerprint) continue;
    const { videoReferences: _videoReferences, ...previous } = JSON.parse(fingerprint) as Record<string, unknown>;
    if (!repairClip || attempt.fingerprint !== JSON.stringify(previous)) throw new Error(STALE_RETRY);
  }
  if (repairClip) return startShortStage(engine, { ...goal, status: "review" }, { action: "approve", revision: content.revision, stage: "videos" }, false);
  await assertRemixPreflight(engine, plan);
  assertStageKey(plan, stage, run?.attempts?.find((attempt) => attempt.chainId === goal.chainId)?.model);
  const { lookup } = await toolLookup(engine);
  retryChainRun(engine, goal.chainId, lookup, { continueOnFailure: stage === "storyboards" });
  return saveGoal(engine, { ...goal, status: "running", error: null });
}
