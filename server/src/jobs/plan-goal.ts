import type { Engine } from "videobook-engine";
import { z } from "zod";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { isCurrentShort, readGoal, requireGoalShortContent, saveGoal, writeGoalShortContent, type GoalRecord } from "../goal-store.js";
import { buildGoalShortPlan, buildLegacyGoalShortPlan, isLegacyShortDraft, shortRemixSourceOf, shortStoryboardOf, type GoalShortDraft } from "../goal-short-plan.js";
import { shortWantsPhone, stripShortBannedWords, withoutShortPhoneSentences } from "../goal-short-rules.js";
import { estimateShort, mentionedSourceFrame } from "../goal-short-runtime.js";
import {
  shortAuthoredCopy, shortBriefPlan, shortPlannerBrief, shortPlannerInstructions, shortPlannerIssues, shortPlannerNeeded, shortPlannerResponseSchema, shortTitle,
  type ShortAuthoredCopy, type ShortPlannerIssue, type ShortPlannerResponse,
} from "../goal-short-planner.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { goalPlannerImages, goalReferenceHashes } from "../goal-reference-images.js";
import { buildRemixAnalysis, collectRemixSource, rememberRemixObservations, remixPlannerFrames } from "../goal-remix-analysis.js";
import { remixPromptFindings, remixRules, remixUnderstandingSchema, type GoalRemixAnalysis } from "../goal-remix-model.js";
import { prepareGoalSourceReference } from "../goal-source-reference.js";

const shortPlannerAnswerSchema = z.object({ title: z.string(), replacement: z.string().optional(), frame: z.string(), beats: z.array(z.string()), understanding: remixUnderstandingSchema.optional() });

function shortPlannerAnswer(text: string): ShortPlannerResponse | null {
  try {
    const parsed = shortPlannerAnswerSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function cleanedAnswer(answer: ShortPlannerResponse, authored: ShortAuthoredCopy, phones: boolean): ShortPlannerResponse {
  const cleaned = (text: string) => phones ? stripShortBannedWords(text) : withoutShortPhoneSentences(stripShortBannedWords(text));
  return {
    title: stripShortBannedWords(answer.title),
    ...(answer.replacement !== undefined ? { replacement: authored.replacement == null ? cleaned(answer.replacement) : answer.replacement } : {}),
    frame: authored.frame === null ? cleaned(answer.frame) : answer.frame,
    beats: answer.beats.map((beat, index) => authored.beats[index] == null ? cleaned(beat) : beat),
    ...(answer.understanding ? { understanding: answer.understanding } : {}),
  };
}

async function askShortPlanner(engine: Engine, goal: GoalRecord, brief: string, draft: GoalShortDraft, authored: ShortAuthoredCopy, signal: AbortSignal, analysis?: GoalRemixAnalysis): Promise<ShortPlannerResponse & { sourceSampleTimes?: number[] }> {
  const notebook = engine.notebooks.read(goal.notebookId);
  if (!notebook.ok) throw new Error(notebook.error.message);
  const references = isLegacyShortDraft(draft) ? [...draft.character.references, ...draft.extraReferences] : [...draft.sourceImages];
  const storyboard = shortStoryboardOf(draft);
  const remix = shortRemixSourceOf(draft);
  const sourceVideo = remix?.video ?? (!isLegacyShortDraft(draft) ? draft.analysisRequest?.sourceVideo : null);
  const count = draft.segmentSeconds.length;
  const options = chatIntelligenceRequestOptions();
  const responses = buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY"), options);
  const fixedBeats = authored.beats.flatMap((beat, index) => beat === null ? [] : [[`beat ${index + 1}`, beat] as const]);
  const phones = shortWantsPhone(brief);
  const sampled = analysis?.source && analysis.source.semanticStatus !== "sampled"
    ? await remixPlannerFrames(engine, analysis.source.artifactId, analysis.source, analysis.recipe.sourceFrameSeconds, signal) : null;
  const request = {
    instructions: await shortPlannerInstructions({
      sourceImageCount: references.length, remix: Boolean(sourceVideo), storyboardFrameCount: storyboard?.frames.length ?? 0, aspectRatio: draft.aspectRatio, segmentSeconds: draft.segmentSeconds,
      ...(analysis ? { analysis } : {}),
    }),
    input: [{ role: "user" as const, content: [
      { type: "input_text" as const, text: JSON.stringify({
        brief: shortPlannerBrief(brief, references, notebook.value, sourceVideo ?? storyboard?.video ?? null, sourceVideo ? "the source video" : "the storyboard"),
        aspectRatio: draft.aspectRatio,
        segments: draft.segmentSeconds.map((seconds, index) => ({ beat: index + 1, seconds })),
        fixed: Object.fromEntries([...(authored.replacement ? [["replacement", authored.replacement] as const] : []), ...(authored.frame === null ? [] : [["frame", authored.frame] as const]), ...fixedBeats]),
        write: ["title", ...(authored.replacement === null ? ["replacement"] : []), ...(authored.frame === null ? ["frame"] : []), ...authored.beats.flatMap((beat, index) => beat === null ? [`beat ${index + 1}`] : [])],
        ...(analysis ? { sourceEvidence: analysis.source, intent: analysis.intent, recipe: analysis.recipe, uncertainties: analysis.findings } : {}),
      }) },
      ...await goalPlannerImages(engine, references, storyboard?.frames ?? [], remix?.frame),
      ...sampled?.content ?? [],
    ] }],
    text: { format: { type: "json_schema" as const, name: "short_plan", strict: true, schema: z.toJSONSchema(shortPlannerResponseSchema(count, Boolean(sourceVideo), Boolean(analysis?.source))) } },
    max_output_tokens: analysis?.source ? 6000 : 2000,
  };
  const first = shortPlannerAnswer(firstResponseText(await responses(intelligenceRequest(request, options), signal)));
  const firstIssues: ShortPlannerIssue[] = first
    ? shortPlannerIssues(first, count, authored, phones)
    : [{ kind: "count", message: "Answer with JSON holding a title, a frame and the beats." }];
  if (first && firstIssues.length === 0) return { ...first, ...(sampled ? { sourceSampleTimes: sampled.times } : {}) };
  const revised = await responses(intelligenceRequest({
    ...request,
    input: [...request.input, {
      role: "user" as const,
      content: `Fix these problems and answer again with the whole plan: ${firstIssues.map((issue) => issue.message).join(" ")}${first ? `\nYour previous answer: ${JSON.stringify(first)}` : ""}`,
    }],
  }, options), signal);
  const second = shortPlannerAnswer(firstResponseText(revised));
  if (!second) throw new Error("The planner did not answer with a plan. Try planning again.");
  const blocking = shortPlannerIssues(second, count, authored, phones).filter((issue) => issue.kind !== "banned" && issue.kind !== "phone");
  if (blocking.length > 0) throw new Error(`The planner's plan still breaks its limits. ${blocking.map((issue) => issue.message).join(" ")} Try planning again.`);
  const cleaned = cleanedAnswer(second, authored, phones);
  if (shortPlannerIssues({ ...cleaned, title: cleaned.title || "Short" }, count, authored, phones).some((issue) => issue.kind === "empty")) {
    throw new Error("The planner's plan was empty without its banned words or phone sentences. Try planning again.");
  }
  return { ...cleaned, ...(sampled ? { sourceSampleTimes: sampled.times } : {}) };
}

async function planShortGoal(engine: Engine, goalId: string, signal: AbortSignal): Promise<{ goalId: string }> {
  try {
    const goal = readGoal(engine, goalId);
    const content = requireGoalShortContent(engine, goal);
    const { draft } = content;
    if (!draft) throw new Error("This short has nothing to plan. Start a new /goal.");
    let remix = shortRemixSourceOf(draft);
    const initial = !isLegacyShortDraft(draft) ? draft.analysisRequest : undefined;
    const sourceVideo = initial?.sourceVideo ?? remix?.video;
    const supplied = content.plan;
    const authored: ShortAuthoredCopy = supplied ? {
      ...(shortRemixSourceOf(supplied) ? { replacement: supplied.version === 5 ? supplied.remix?.replacement.prompt : undefined } : {}),
      frame: supplied.frame.prompt, beats: supplied.segments.map(segment => segment.prompt), segmentSeconds: supplied.segments.map(segment => segment.seconds), note: null,
    } : shortAuthoredCopy(content.brief, draft.segmentSeconds, Boolean(sourceVideo));
    const plannedDraft = { ...draft, segmentSeconds: authored.segmentSeconds };
    const source = initial?.sourceVideo ? { ...await collectRemixSource(engine, initial.sourceVideo.artifactId, signal), artifactId: initial.sourceVideo.artifactId } : null;
    const analysisInput = initial ? {
      brief: content.brief, totalSeconds: plannedDraft.segmentSeconds.reduce((sum, seconds) => sum + seconds, 0), notebookId: goal.notebookId,
      preferences: initial.preferences, source, requestedFrameSeconds: initial.atSeconds,
      ...(initial.intent ? { intent: initial.intent } : {}),
    } : null;
    let analysis = analysisInput ? await buildRemixAnalysis(engine, analysisInput) : undefined;
    const written = !supplied && shortPlannerNeeded(content.brief, plannedDraft.segmentSeconds, Boolean(sourceVideo))
      ? await askShortPlanner(engine, goal, content.brief, plannedDraft, authored, signal, analysis)
      : null;
    if (analysisInput && source && written?.understanding) {
      const remembered = written.sourceSampleTimes ? await rememberRemixObservations(engine, source.artifactId, source, written.understanding, written.sourceSampleTimes, chatIntelligenceRequestOptions().model) : source;
      analysis = await buildRemixAnalysis(engine, { ...analysisInput, source: { ...remembered, artifactId: source.artifactId }, understanding: written.understanding });
    }
    signal.throwIfAborted();
    if (analysis?.source && analysis.recipe.sourceFrameSeconds !== null && !analysis.findings.some(finding => finding.severity === "error")) {
      const reference = await prepareGoalSourceReference(engine, analysis.source.artifactId, analysis.recipe.sourceFrameSeconds, goal.notebookId, signal);
      analysis = { ...analysis, recipe: { ...analysis.recipe, reference: { start: reference.start, end: reference.end }, referenceArtifactId: reference.artifactId, referenceMediaHash: reference.mediaHash } };
    }
    if (initial?.sourceVideo) {
      const made = await mentionedSourceFrame(engine, goal.bookId, goal.notebookId, initial.sourceVideo, initial.sourceVideo.address ?? "The source video", analysis?.recipe.sourceFrameSeconds ?? initial.atSeconds);
      if (!made.remix) throw new Error(made.note.kind === "text" ? made.note.text : "No source frame could be prepared.");
      remix = made.remix;
      if (analysis?.intent.cleanup === "keep") {
        const [hash] = await goalReferenceHashes(engine, [remix.frame.artifactId]);
        analysis = { ...analysis, recipe: { ...analysis.recipe, preparedFrameArtifactId: remix.frame.artifactId, preparedFrameMediaHash: hash?.objectHash ?? null } };
      }
    }
    const offline = written ? null : shortBriefPlan(content.brief, authored, analysis);
    const framePrompt = authored.frame ?? written?.frame ?? offline?.frame ?? "";
    const title = written?.title || shortTitle(content.brief, framePrompt);
    const beats = authored.beats.map((beat, index) => beat ?? written?.beats[index] ?? offline?.beats[index] ?? "");
    let plan = supplied ?? (isLegacyShortDraft(plannedDraft)
      ? buildLegacyGoalShortPlan({
        title, aspectRatio: plannedDraft.aspectRatio, character: plannedDraft.character,
        framePrompt, beats, segmentSeconds: plannedDraft.segmentSeconds, extraReferences: plannedDraft.extraReferences,
      })
      : buildGoalShortPlan({
        title, aspectRatio: plannedDraft.aspectRatio, sourceImages: plannedDraft.sourceImages, storyboard: shortStoryboardOf(plannedDraft),
        remix, replacementPrompt: authored.replacement ?? written?.replacement ?? offline?.replacement,
        framePrompt, beats, segmentSeconds: plannedDraft.segmentSeconds,
        ...(analysis ? { analysis } : {}),
      }));
    if (plan.version === 5 && analysis) {
      plan = { ...plan, ...(remix && plan.remix ? { remix: { ...remix, replacement: plan.remix.replacement } } : {}),
        ...(initial?.intent ? { rules: remixRules(analysis.intent) } : {}), analysis };
      const findings = remixPromptFindings(analysis, [plan.frame.prompt, plan.remix?.replacement.prompt ?? "", ...plan.segments.map(segment => segment.prompt), ...Object.values(plan.rules)]);
      plan.analysis = { ...analysis, findings: [...analysis.findings, ...findings] };
    }
    const estimate = await estimateShort(engine, plan, content);
    const added = [authored.note, offline?.note ?? null,
      initial?.sourceVideo && remix ? `Prepared the source frame at ${remix.frame.atSeconds.toFixed(1)} s. Review the initial analysis before generating.` : null,
    ].filter((note): note is string => note !== null);
    await withNotebookMutation(`goal:${goalId}`, async () => {
      const current = readGoal(engine, goalId);
      if (current.status !== "planning") return;
      const latest = requireGoalShortContent(engine, current);
      if (latest.revision !== content.revision || latest.brief !== content.brief) return;
      signal.throwIfAborted();
      const notes = [...latest.notes];
      for (const note of added) {
        if (!notes.includes(note)) notes.push(note);
      }
      await writeGoalShortContent(engine, current, { ...latest, draft: plannedDraft, plan, estimate, notes, revision: latest.revision + 1 });
      saveGoal(engine, { ...current, stage: shortRemixSourceOf(plan) ? "replacement" : shortStoryboardOf(plan) ? "storyboards" : "frame", status: "review", error: null });
    });
    return { goalId };
  } catch (error) {
    await withNotebookMutation(`goal:${goalId}`, async () => {
      const current = readGoal(engine, goalId);
      if (current.status === "planning") saveGoal(engine, { ...current, status: "failed", error: error instanceof Error ? error.message : String(error) });
    });
    throw error;
  }
}

export function registerPlanGoalJob(engine: Engine): void {
  registerJobHandler("plan_goal", async (payload, context) => {
    const goalId = String(payload.goalId);
    const goal = readGoal(engine, goalId);
    return isCurrentShort(goal.planVersion) && goal.status === "planning" ? planShortGoal(engine, goalId, context.signal) : { goalId };
  });
}
