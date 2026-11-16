import { createHash } from "node:crypto";
import { v7 as uuidv7 } from "uuid";
import { findPrimaryMediaFile, type Engine } from "videobook-engine";
import { z } from "zod";
import { analysisComponentKey, readAnalysisComponent, type AnalysisComponentSpec } from "./analysis-components.js";
import { chatIntelligenceRequestOptions } from "./chat-models.js";
import { forecastLanguageCall } from "./cost.js";
import { goalGenerationLineageSchema } from "./goal-generation-provenance.js";
import { goalBrandingTitleSlots } from "./goal-finish-model.js";
import { reviewedGoalOutput } from "./goal-generation-history.js";
import { remixAssemblyReviewKey } from "./goal-remix-model.js";
import { goalReferenceHashes } from "./goal-reference-images.js";
import { goalQualityResultSchema, type GoalOutputCheck } from "./goal-quality-model.js";
import { shortGenerationSegments, type GoalShortPlan } from "./goal-short-plan.js";
import { shortFingerprint, shortFrameStale, shortSegmentStale } from "./goal-short-runtime.js";
import { requireGoalShortContent, saveGoal, type GoalEstimate, type GoalRecord } from "./goal-store.js";
import { queue } from "./queue.js";

export const GOAL_QUALITY: AnalysisComponentSpec = { component: "goal-output-quality", version: 1, jobType: "check_goal_output" };
export const GOAL_QUALITY_OUTPUT_TOKENS = 2400;
const GOAL_QUALITY_STAGE = z.enum(["replacement", "frame", "videos", "finish"]);
const referenceSchema = z.object({ artifactId: z.string(), expectedHash: z.string().nullable(), currentHash: z.string().nullable(), role: z.string() }).strict();
export const goalQualityRequestSchema = z.object({
  version: z.literal(1), goalId: z.string(), key: z.string(), slot: z.string(), stage: GOAL_QUALITY_STAGE, index: z.number().int().nonnegative(),
  artifactId: z.string(), mediaHash: z.string(), semantic: z.boolean(), model: z.string(),
  constraints: z.record(z.string(), z.unknown()), constraintHash: z.string(), references: z.array(referenceSchema),
  expectedSeconds: z.number().positive(), retainedStart: z.number().nonnegative(), retainedSeconds: z.number().positive(),
  fps: z.number().positive().nullable(), width: z.number().positive().nullable(), height: z.number().positive().nullable(),
  expectedFrames: z.number().int().positive().nullable(), sampleTimes: z.array(z.number().nonnegative()),
  assembly: z.boolean(), reviewedWindow: z.boolean(), stale: z.boolean(), provenance: z.record(z.string(), z.unknown()).nullable(), provenanceHash: z.string().nullable(),
}).strict();
export type GoalQualityRequest = z.infer<typeof goalQualityRequestSchema>;

export function readGoalQualityResult(engine: Engine, key: string) {
  const durable = goalQualityResultSchema.safeParse(engine.settings.get(`goal.quality.attempt.${key}`));
  return durable.success ? durable.data : readAnalysisComponent(engine, GOAL_QUALITY, key, goalQualityResultSchema)?.value ?? null;
}

function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

function constraints(plan: GoalShortPlan, goal: GoalRecord, stage: GoalQualityRequest["stage"], index: number): Record<string, unknown> {
  if (plan.version !== 5 || !plan.analysis) throw new Error("Analyze this goal before checking its output against the brief.");
  const { intent, recipe } = plan.analysis;
  const { audio: _audio, origins: _origins, ...visualIntent } = intent;
  return {
    brief: plan.analysis.brief, intent: visualIntent, scope: stage,
    prompt: stage === "replacement" ? plan.remix?.replacement.prompt : stage === "frame" ? plan.frame.prompt : stage === "videos" ? shortGenerationSegments(plan)[index]?.prompt : null,
    assembly: recipe.assembly,
    ...(stage === "videos" && recipe.assembly ? { actionWindow: goal.actionWindow ? { startFrame: goal.actionWindow.startFrame, endFrame: goal.actionWindow.endFrame, mediaHash: goal.actionWindow.mediaHash } : null } : {}),
    ...(stage === "finish" ? { audio: intent.audio, soundtrack: recipe.soundtrack, branding: plan.analysis.preferences.branding ? recipe.branding : null, title: plan.finish.title } : {}),
  };
}

export function goalQualityEstimate(plan: GoalShortPlan): GoalEstimate {
  const quote = forecastLanguageCall(chatIntelligenceRequestOptions().model, JSON.stringify(plan.version === 5 ? plan.analysis?.intent ?? {} : {}), GOAL_QUALITY_OUTPUT_TOKENS);
  return { usd: null, warnings: ["Semantic review includes image input whose price is not available in this estimate. Review manually, or explicitly request a paid check; automatic runs cannot reserve an unknown total.",
    ...(quote.status === "unavailable" ? quote.warnings : [`Text/output portion estimated at $${quote.usd.toFixed(4)}; image input is additional.`])] };
}

export async function makeGoalQualityRequest(engine: Engine, goal: GoalRecord, stage: GoalQualityRequest["stage"], index: number, semantic: boolean): Promise<GoalQualityRequest> {
  const { plan } = requireGoalShortContent(engine, goal);
  if (plan?.version !== 5 || !plan.analysis) throw new Error("Analyze this goal before checking its output against the brief.");
  const { analysis } = plan;
  const artifactId = stage === "finish" ? goal.finish?.finalArtifactId : goal.stages[stage]?.outputs.find(value => value.index === index)?.artifactId;
  if (!artifactId) throw new Error("Keep the output selected before checking it.");
  const manifest = await engine.files.manifest(artifactId);
  const still = stage === "frame" || stage === "replacement";
  const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, still ? "image" : "video") : null;
  if (!file) throw new Error("The selected output has no readable media.");
  const { recipe, source } = analysis;
  const references = [
    ...plan.sourceImages.map(value => ({ artifactId: value.artifactId, expectedHash: value.objectHash, role: "identity" })),
    ...(source ? [{ artifactId: source.artifactId, expectedHash: source.mediaHash, role: "source" }] : []),
    ...(recipe.preparedArtifactId ? [{ artifactId: recipe.preparedArtifactId, expectedHash: recipe.preparedMediaHash, role: "prepared-source" }] : []),
    ...(stage === "finish" ? [
      ...(goal.finish?.sourceObjectHash ? [{ artifactId: goal.finish.sourceArtifactId, expectedHash: goal.finish.sourceObjectHash, role: "selected-take" }] : []),
      ...(analysis.preferences.branding ? recipe.branding?.images.map(value => ({ artifactId: value.artifactId, expectedHash: value.mediaHash, role: "branding" })) ?? [] : []),
      ...(["source", "mix"].includes(analysis.intent.audio) && recipe.soundtrack ? [{ artifactId: recipe.soundtrack.artifactId, expectedHash: recipe.soundtrack.mediaHash, role: "soundtrack" }] : []),
    ] : []),
  ];
  const storedLineage = await engine.metadata.artifacts.read<unknown>(artifactId, "goal-generation-lineage");
  const lineage = goalGenerationLineageSchema.safeParse(storedLineage.ok ? storedLineage.value : null);
  if (lineage.success) references.push(...lineage.data.references.map(value => ({ artifactId: value.artifactId, expectedHash: value.objectHash, role: `generation-${value.role}` })));
  const hashes = await goalReferenceHashes(engine, references.map(value => value.artifactId));
  const pinned = references.map((value, position) => ({ ...value, currentHash: hashes[position]?.objectHash ?? null }));
  const material = constraints(plan, goal, stage, index);
  const assembly = recipe.assembly;
  const window = stage === "videos" && assembly ? goal.actionWindow : null;
  const retainedSeconds = stage === "videos" && assembly ? (assembly.changeEndFrame - assembly.changeStartFrame) / assembly.fps
    : stage === "videos" ? shortGenerationSegments(plan)[index]?.seconds ?? recipe.targetSeconds : recipe.targetSeconds;
  const expectedSeconds = stage === "finish" ? recipe.targetSeconds : stage === "videos" && !assembly
    ? plan.segments.slice(0, index + 1).reduce((sum, value) => sum + value.seconds, 0) : shortGenerationSegments(plan)[index]?.seconds ?? recipe.targetSeconds;
  const retainedStart = window && assembly ? window.startFrame / assembly.fps : stage === "videos" && !assembly ? Math.max(0, expectedSeconds - retainedSeconds) : 0;
  const plannedTimes = recipe.checkTimes.filter(time => time >= Math.max(0, retainedStart - 0.1) && time < expectedSeconds);
  const segmentTimes = Array.from({ length: 7 }, (_, at) => retainedStart + Math.max(0, retainedSeconds - 0.1) * at / 6);
  const sampleTimes = still ? [] : stage === "videos" && assembly
    ? [...new Set([Math.max(0, retainedStart - 0.1), ...Array.from({ length: 7 }, (_, at) => retainedStart + (retainedSeconds - Math.min(0.1, 1 / assembly.fps)) * at / 6), retainedStart + retainedSeconds + 0.1])]
    : stage === "videos" ? [...new Set([...plannedTimes, ...segmentTimes])].slice(0, 12).sort((left, right) => left - right) : recipe.checkTimes;
  const model = chatIntelligenceRequestOptions().model;
  const branding = analysis.preferences.branding ? recipe.branding ?? null : null;
  const slots = recipe.branding ? goalBrandingTitleSlots(recipe.branding, analysis.preferences.branding) : null;
  const title = plan.finish.title && slots?.headline ? { headline: plan.finish.title.headline, secondary: slots.secondary ? plan.finish.title.secondary : "" } : null;
  const provenance = stage === "finish" ? {
    sourceArtifactId: goal.finish?.sourceArtifactId, sourceObjectHash: goal.finish?.sourceObjectHash,
    title, recipe: { version: 1, branding, audio: analysis.intent.audio, soundtrack: recipe.soundtrack ?? null },
    edit: assembly ? { version: 1, assembly, original: { artifactId: source?.artifactId, mediaHash: source?.mediaHash },
      source: { artifactId: recipe.preparedArtifactId, mediaHash: recipe.preparedMediaHash },
      clip: { artifactId: goal.finish?.sourceArtifactId, mediaHash: goal.actionWindow?.mediaHash }, startFrame: goal.actionWindow?.startFrame, audio: analysis.intent.audio } : null,
  } : null;
  const generationStage = stage === "finish" ? "videos" : stage;
  const generationIndex = stage === "finish" ? Math.max(0, shortGenerationSegments(plan).length - 1) : index;
  const output = goal.stages[generationStage]?.outputs.find(value => value.index === generationIndex);
  const attempt = reviewedGoalOutput(goal, generationStage, generationIndex, output?.artifactId)
    ?? goal.stages[generationStage]?.attempts?.find(value => value.index === generationIndex && value.artifactId === output?.artifactId);
  const upstream = generationStage === "replacement" ? null : generationStage === "frame" ? goal.stages.replacement?.outputs[0]?.artifactId ?? goal.stages.storyboards?.outputs[0]?.artifactId ?? null
    : (generationIndex === 0 ? goal.stages.frame?.outputs[0] : goal.stages.videos?.outputs.find(value => value.index === generationIndex - 1))?.artifactId ?? null;
  const stale = (generationStage === "replacement" ? false : generationStage === "frame" ? shortFrameStale(goal) : shortSegmentStale(goal, generationIndex))
    || Boolean(attempt?.fingerprint && attempt.fingerprint !== await shortFingerprint(engine, plan, generationStage, generationIndex, upstream));
  const request = { version: 1, goalId: goal.goalId, slot: `${stage}:${index}`, stage, index, artifactId, mediaHash: file.objectHash, semantic, model,
    constraints: material, constraintHash: digest(material), references: pinned, expectedSeconds, retainedStart, retainedSeconds,
    fps: stage === "finish" ? assembly?.fps ?? null : null, width: stage === "finish" ? assembly?.width ?? null : null, height: stage === "finish" ? assembly?.height ?? null : null,
    expectedFrames: stage === "finish" ? assembly?.totalFrames ?? null : null, sampleTimes, assembly: Boolean(assembly),
    stale, provenance, provenanceHash: stage === "finish" && manifest.ok ? manifest.value.files.find(value => value.name === "goal-finish.json")?.objectHash ?? null : null,
    reviewedWindow: Boolean(window && assembly && window.artifactId === artifactId && window.mediaHash === file.objectHash
      && window.recipeKey === remixAssemblyReviewKey(analysis) && window.endFrame - window.startFrame === assembly.changeEndFrame - assembly.changeStartFrame) };
  const key = analysisComponentKey(GOAL_QUALITY, { sourceHash: file.objectHash, dependencies: pinned.map(value => `${value.role}:${value.expectedHash}:${value.currentHash}`),
    options: { ...request, goalId: undefined, artifactId: undefined, semantic: undefined, references: undefined } });
  return goalQualityRequestSchema.parse({ ...request, key });
}

export async function queueGoalOutputCheck(engine: Engine, goal: GoalRecord, args: Record<string, unknown>): Promise<GoalRecord> {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status) || goal.finish?.status === "running") throw new Error("Stop the current work before checking its output.");
  const content = requireGoalShortContent(engine, goal);
  if (args.revision !== content.revision) throw new Error("The goal changed. Review its current revision first.");
  const stage = GOAL_QUALITY_STAGE.parse(args.stage);
  const index = z.number().int().nonnegative().parse(args.index ?? 0);
  const semantic = args.semantic === true;
  const request = await makeGoalQualityRequest(engine, goal, stage, index, semantic);
  const previous = goal.quality?.[request.slot];
  if (previous?.key === request.key && previous.status === "running" && previous.jobId) {
    const job = engine.jobs.queue.get(previous.jobId);
    if (job && ["queued", "running", "completing"].includes(job.state)) {
      if (semantic && !previous.semantic) throw new Error("Local checks are running. Wait for them to finish before requesting a paid review.");
      return goal;
    }
  }
  const cached = readGoalQualityResult(engine, request.key);
  if (cached && (!semantic || cached.semantic.attempted || cached.technical.status === "fail")) {
    const check: GoalOutputCheck = { status: "completed", key: request.key, artifactId: request.artifactId, mediaHash: request.mediaHash, stage, index, semantic, jobId: null, result: cached, error: null };
    return saveGoal(engine, { ...goal, quality: { ...goal.quality, [request.slot]: check } });
  }
  const job = await queue.enqueue(`goal-quality-${goal.goalId}-${request.key}-${uuidv7()}`, { type: GOAL_QUALITY.jobType, bookId: goal.bookId, runId: goal.goalId, notebookId: goal.notebookId, request });
  const check: GoalOutputCheck = { status: "running", key: request.key, artifactId: request.artifactId, mediaHash: request.mediaHash, stage, index, semantic, jobId: job.id, result: null, error: null };
  return saveGoal(engine, { ...goal, quality: { ...goal.quality, [request.slot]: check } });
}

export async function reconcileGoalQuality(engine: Engine, goal: GoalRecord): Promise<GoalRecord> {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status) || goal.finish?.status === "running") return goal;
  const content = requireGoalShortContent(engine, goal);
  if (content.plan?.version !== 5 || !content.plan.analysis?.recipe.outputAssertions) return goal;
  const slots = [
    ...(["replacement", "frame", "videos"] as const).flatMap(stage => (goal.stages[stage]?.outputs ?? []).map(output => ({ stage, index: output.index }))),
    ...(goal.finish?.finalArtifactId ? [{ stage: "finish" as const, index: 0 }] : []),
  ];
  for (const { stage, index } of slots) {
    const request = await makeGoalQualityRequest(engine, goal, stage, index, false).catch(() => null);
    if (!request) continue;
    const previous = goal.quality?.[request.slot];
    if (previous?.key === request.key) {
      const job = previous.jobId ? engine.jobs.queue.get(previous.jobId) : null;
      if (previous.status === "running" && (!job || ["done", "failed", "aborted"].includes(job.state))) {
        const result = readGoalQualityResult(engine, request.key);
        goal = saveGoal(engine, { ...goal, quality: { ...goal.quality, [request.slot]: { ...previous, status: result ? "completed" : "failed", result,
          error: result ? null : job?.error?.message ?? "The output check stopped before it answered. Run the local check again." } } });
      }
      continue;
    }
    goal = await queueGoalOutputCheck(engine, goal, { revision: content.revision, stage, index });
  }
  return goal;
}
