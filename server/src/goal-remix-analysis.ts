import type { Engine } from "videobook-engine";
import { analysisComponentKey, readAnalysisComponent, writeAnalysisComponent } from "./analysis-components.js";
import { cachedSidecarAnalysis, fileObjectHash } from "./analysis-sidecars.js";
import { getApiKey } from "./api-key.js";
import { extractFrames } from "./captions/frames.js";
import { captionMediaSource } from "./captions/source.js";
import { cachedFrameRegions } from "./frame-regions.js";
import { probeVideo } from "./ffmpeg.js";
import {
  goalRemixAnalysisSchema, remixPreferencesSchema, remixSourceEvidenceSchema, resolveRemixIntent,
  type GoalRemixAnalysis, type RemixFinding, type RemixPreferences, type RemixSourceEvidence, type RemixUnderstanding,
} from "./goal-remix-model.js";
import { shortRemixOf } from "./goal-short-plan.js";
import { storyboardMoments } from "./goal-short-storyboard.js";
import { listGoals, requireGoalShortContent } from "./goal-store.js";
import { readGraphicsTemplates } from "./graphics/templates.js";
import { selectSceneCuts } from "./scene-cuts.js";
import { DEFAULT_TRANSCRIPT_OPTIONS, hasCurrentElevenLabsTranscript, OPENAI_TRANSCRIPT, openAiTranscriptRecord } from "./transcript-components.js";
import { readTranscriptSidecarText } from "./transcript-projection.js";
import { awaitScenes } from "./tools/detect-scenes.js";
import { cleanupModelStatus } from "./video-cleanup/models.js";
import { cleanupCandidates } from "./video-cleanup/prepared.js";
import { cleanupFrameCount } from "./video-cleanup/model.js";
import { readVideoAnalysisSummary } from "./video-analysis-projection.js";
import { VIDEO_ANALYSIS, videoAnalysisInputs, videoAnalysisRecord } from "./vision-components.js";

const PREFERENCES_KEY = "application.goal.remix-preferences.v1";
const SOURCE_EVIDENCE = { component: "goal-source-evidence", version: 2, jobType: "plan_goal" };

export function readRemixPreferences(engine: Engine): RemixPreferences {
  const parsed = remixPreferencesSchema.safeParse(engine.settings.get<unknown>(PREFERENCES_KEY) ?? {});
  return parsed.success ? parsed.data : remixPreferencesSchema.parse({});
}

export function writeRemixPreferences(engine: Engine, value: unknown): RemixPreferences {
  const preferences = remixPreferencesSchema.parse(value);
  const written = engine.settings.set(PREFERENCES_KEY, preferences);
  if (!written.ok) throw new Error(written.error.message);
  return preferences;
}

async function currentTranscript(engine: Engine, artifactId: string, audioHash: string | null): Promise<string | null> {
  if (!audioHash) return null;
  const timed = await hasCurrentElevenLabsTranscript(engine, { artifactId, audioHash, options: DEFAULT_TRANSCRIPT_OPTIONS });
  const plain = await cachedSidecarAnalysis(engine, OPENAI_TRANSCRIPT, openAiTranscriptRecord(artifactId, audioHash));
  if (!timed && !plain) return null;
  const transcript = await readTranscriptSidecarText(engine, artifactId, timed ? "elevenlabs" : "plain");
  return transcript?.text.slice(0, 6000) ?? null;
}

export async function collectRemixSource(engine: Engine, artifactId: string, signal: AbortSignal): Promise<RemixSourceEvidence> {
  signal.throwIfAborted();
  const source = await captionMediaSource(engine, artifactId);
  const scenes = await awaitScenes(engine, artifactId, engine.book.get().bookId);
  signal.throwIfAborted();
  const inputs = await videoAnalysisInputs(engine, artifactId, true);
  const dependencies = await Promise.all([VIDEO_ANALYSIS.sidecar, "elevenlabs.json", ".analysis.gpt4otrans.json", ".detect-scenes.json"]
    .map(name => fileObjectHash(engine, artifactId, name)));
  const key = analysisComponentKey(SOURCE_EVIDENCE, { sourceHash: source.mediaHash, dependencies: dependencies.filter((hash): hash is string => hash !== null) });
  const cached = readAnalysisComponent(engine, SOURCE_EVIDENCE, key, remixSourceEvidenceSchema);
  if (cached) return cached.value;
  const imported = inputs && await cachedSidecarAnalysis(engine, VIDEO_ANALYSIS, videoAnalysisRecord(engine, artifactId, inputs))
    ? await readVideoAnalysisSummary(engine, artifactId) : null;
  const regions = cachedFrameRegions(engine, source.mediaHash).flatMap(frame => frame.regions
    .filter(region => region.kind !== "face" && region.width > 0 && region.height > 0)
    .map(region => ({ description: "Previously detected text or graphic; confirm whether it is overlaid or physical.", kind: "uncertain" as const,
      x: region.x, y: region.y, width: region.width, height: region.height,
      start: Math.max(0, frame.time - 0.125), end: Math.min(source.durationSeconds, frame.time + 0.125) })))
    .filter(region => region.end > region.start).slice(0, 40);
  const cuts = selectSceneCuts(scenes);
  const probe = await probeVideo(source.path);
  const observations = imported || regions.length ? {
    summary: imported?.summary.slice(0, 1600) ?? "", subjects: imported?.subjects.slice(0, 20).map(text => text.slice(0, 200)) ?? [], actions: [], overlays: regions,
  } : null;
  const value: RemixSourceEvidence = {
    mediaHash: source.mediaHash, durationSeconds: source.durationSeconds, fps: probe.avgFps || probe.fps,
    width: source.width, height: source.height, hasAudio: source.hasAudio, cuts,
    sampleTimes: storyboardMoments({ durationSeconds: source.durationSeconds, cutSeconds: cuts, count: 6 }),
    observations, semanticStatus: imported ? "imported" : "missing", transcript: await currentTranscript(engine, artifactId, source.audioFile?.objectHash ?? null), evidenceKey: key,
  };
  if ((await captionMediaSource(engine, artifactId)).mediaHash !== source.mediaHash) throw new Error("The source video changed during analysis. Analyze it again.");
  writeSourceEvidence(engine, artifactId, value);
  return value;
}

function writeSourceEvidence(engine: Engine, artifactId: string, value: RemixSourceEvidence, model: string | null = null): void {
  writeAnalysisComponent(engine, {
    component: SOURCE_EVIDENCE.component, key: value.evidenceKey, artifactId, sourceHash: value.mediaHash,
    provenance: { analyzer: "goal-initial-analysis", version: SOURCE_EVIDENCE.version, provider: model ? "openai" : null, model, createdAt: new Date().toISOString() },
    value: remixSourceEvidenceSchema.strip().parse(value),
  });
}

export async function rememberRemixObservations(engine: Engine, artifactId: string, source: RemixSourceEvidence, understanding: RemixUnderstanding, sampleTimes: number[], model: string): Promise<RemixSourceEvidence> {
  if ((await captionMediaSource(engine, artifactId)).mediaHash !== source.mediaHash) throw new Error("The source changed while its frames were analyzed.");
  const observations = understanding.observations;
  const value: RemixSourceEvidence = { ...source, sampleTimes, semanticStatus: "sampled", observations: {
    ...observations,
    actions: observations.actions.filter(action => action.atSeconds < source.durationSeconds),
    overlays: observations.overlays.filter(region => region.end > region.start && region.start < source.durationSeconds
      && region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001)
      .map(region => ({ ...region, end: Math.min(region.end, source.durationSeconds) })),
  } };
  writeSourceEvidence(engine, artifactId, value, model);
  return value;
}

export async function remixPlannerFrames(engine: Engine, artifactId: string, source: RemixSourceEvidence, atSeconds: number | null, signal: AbortSignal) {
  const current = await captionMediaSource(engine, artifactId);
  if (current.mediaHash !== source.mediaHash) throw new Error("The source video changed before planning.");
  const times = [...new Set([...source.sampleTimes, ...(atSeconds === null ? [] : [Math.max(0, atSeconds - 1 / source.fps), atSeconds])])].slice(0, 8);
  const frames = await extractFrames(current.path, times.map((time, index) => ({ id: `source-${index}`, time })), source.durationSeconds, signal);
  return { times: frames.map(frame => frame.time), content: frames.flatMap(frame => [
    { type: "input_text" as const, text: `Source video sample at ${frame.time.toFixed(3)} s` },
    { type: "input_image" as const, image_url: `data:image/jpeg;base64,${frame.buffer.toString("base64")}`, detail: "high" as const },
  ]) };
}

function failureKind(message: string | null): GoalRemixAnalysis["history"][number]["failure"] {
  if (!message) return null;
  if (/\b(?:401|403|balance|credits?|unauthori[sz]ed|quota)\b/iu.test(message)) return "account";
  if (/\b(?:400|422|invalid|validation|required|reference)\b/iu.test(message)) return "request";
  if (/\b(?:network|timeout|timed out|ECONNRESET|download|poll)\b/iu.test(message)) return "transport";
  return "unknown";
}

function relatedHistory(engine: Engine, notebookId: string, sourceArtifactId: string | null): GoalRemixAnalysis["history"] {
  if (!sourceArtifactId) return [];
  const rows: GoalRemixAnalysis["history"] = [];
  for (const goal of listGoals(engine, notebookId)) {
    if (goal.planVersion !== 5) continue;
    let source: string | undefined;
    try { source = shortRemixOf(requireGoalShortContent(engine, goal).plan)?.video.artifactId; } catch { continue; }
    if (source !== sourceArtifactId) continue;
    for (const [stage, run] of Object.entries(goal.stages)) {
      for (const attempt of run?.attempts ?? []) {
        rows.push({ goalId: goal.goalId, artifactId: attempt.artifactId, stage,
          selected: Boolean(run?.outputs.some(output => output.artifactId === attempt.artifactId)),
          status: goal.status, failure: failureKind(goal.error) });
      }
    }
  }
  return rows.slice(0, 100);
}

function sourceReferenceRange(source: RemixSourceEvidence, frameSeconds: number): { start: number; end: number } {
  const length = Math.min(15, source.durationSeconds);
  const start = Math.max(0, Math.min(source.durationSeconds - length, frameSeconds - length / 2));
  return { start, end: start + length };
}

export async function buildRemixAnalysis(engine: Engine, input: {
  brief: string; totalSeconds: number; notebookId: string; preferences: RemixPreferences;
  source: (RemixSourceEvidence & { artifactId: string }) | null;
  requestedFrameSeconds?: number | null; understanding?: RemixUnderstanding | null;
  intent?: GoalRemixAnalysis["intent"];
}): Promise<GoalRemixAnalysis> {
  const { source, understanding, preferences, totalSeconds } = input;
  const intent = input.intent ?? resolveRemixIntent({ ...input, source: source !== null });
  if (!input.intent && !engine.settings.get(PREFERENCES_KEY)) {
    intent.origins = Object.fromEntries(Object.entries(intent.origins).map(([name, origin]) => [name, origin === "preset" ? "default" : origin]));
  }
  const findings: RemixFinding[] = [];
  const action = intent.action;
  if (action && action.end > totalSeconds) findings.push({ code: "action-range", severity: "error", text: "The requested action extends past the planned video duration." });
  const fallbackFrame = source ? storyboardMoments({ durationSeconds: source.durationSeconds, cutSeconds: source.cuts, count: 1 })[0] : null;
  const chosen = input.requestedFrameSeconds ?? understanding?.sourceFrameSeconds ?? action?.start ?? fallbackFrame ?? null;
  if (source && chosen !== null && chosen >= source.durationSeconds) findings.push({ code: "source-frame", severity: "error", text: "The requested source frame is outside the video." });
  const frameSeconds = source && chosen !== null ? Math.min(chosen, source.durationSeconds - 1 / source.fps) : null;
  const localized = Boolean(source && intent.structure === "preserve-source" && action && action.end <= totalSeconds);
  const keep = localized && action ? [
    ...(action.start > 0 ? [{ start: 0, end: action.start }] : []),
    ...(action.end < totalSeconds ? [{ start: action.end, end: totalSeconds }] : []),
  ] : [];
  if (source && keep.some(range => range.end > source.durationSeconds + 1 / source.fps)) findings.push({ code: "short-source", severity: "error", text: "The source is shorter than a range the plan needs to preserve." });
  if (source && intent.structure === "preserve-source" && !action) findings.push({ code: "change-range", severity: "review", text: "Choose which interval changes so the remaining source shots can be preserved." });
  if (source && source.durationSeconds < 2) findings.push({ code: "short-reference", severity: "error", text: "H3 Max needs a reference video of at least two seconds. Select a longer source or use image references." });
  if (source && (intent.audio === "source" || intent.audio === "mix") && !source.hasAudio) findings.push({ code: "missing-audio", severity: "review", text: "The source has no audio. Choose generated ambience or mute." });
  if (source && source.semanticStatus !== "sampled") findings.push({ code: "unverified-source", severity: "review", text: "Source action and overlays have not been verified in the sampled frames. Review them before continuing automatically." });
  if (!getApiKey("FAL_API_KEY")) findings.push({ code: "provider-key", severity: "note", text: "Set FAL_API_KEY before generating images or video." });
  for (const text of understanding?.uncertainties ?? []) findings.push({ code: "uncertain-source", severity: "review", text });
  const overlays = source?.observations?.overlays ?? [];
  const cleanupRegions = overlays.filter(region => region.kind === "overlay").map((region, index) => ({
    id: `overlay-${index + 1}`, x: region.x, y: region.y, width: region.width, height: region.height, start: region.start, end: region.end,
  }));
  const models = source ? await cleanupModelStatus() : null;
  const candidates = source ? await cleanupCandidates(engine, source.artifactId, source.mediaHash) : [];
  if (source && intent.cleanup !== "keep" && (overlays.length > 0 || intent.cleanup === "remove")) {
    findings.push({ code: "cleanup-review", severity: "review", text: "Review the overlay regions before removal; keep physical signs and printing. Sampled detection cannot prove that every overlay was found." });
    if (!models?.lama) findings.push({ code: "cleanup-model", severity: "note", text: "Local AI removal needs its downloaded model. Fill removal or an existing cleaned copy remains available after review." });
  }
  const templates = readGraphicsTemplates(engine);
  const templateId = templates.watermark.tiktok ?? templates.defaultId;
  const template = templates.templates.find(candidate => candidate.id === templateId);
  const change = localized && action ? [action] : [{ start: 0, end: totalSeconds }];
  const generatedSeconds = Math.max(0.92, Math.ceil(change.reduce((sum, range) => sum + range.end - range.start, 0) * 100) / 100);
  const checkTimes = [...new Set([0, ...source?.cuts ?? [], ...(action ? [Math.max(0, action.start - 0.1), action.start + 0.1, (action.start + action.end) / 2, action.end - 0.1] : [totalSeconds / 2]), totalSeconds - 0.1])]
    .filter(time => time >= 0 && time < totalSeconds).sort((left, right) => left - right);
  return goalRemixAnalysisSchema.parse({
    version: 1, brief: input.brief, preferences, source, intent,
    recipe: { targetSeconds: totalSeconds, sourceFrameSeconds: frameSeconds, keep, change, generatedSeconds,
      reference: source && frameSeconds !== null ? sourceReferenceRange(source, frameSeconds) : null,
      preparedArtifactId: intent.cleanup === "keep" ? source?.artifactId ?? null : null,
      preparedMediaHash: intent.cleanup === "keep" ? source?.mediaHash ?? null : null,
      cleanupReviewedHash: intent.cleanup === "keep" ? source?.mediaHash ?? null : null,
      cleanupRegions, cleanupConfirmed: intent.cleanup === "keep", cleanupCandidates: candidates,
      cleanupFrames: source ? cleanupFrameCount(cleanupRegions, source.fps) : 0,
      cleanupModelReady: models?.lama ?? false, cleanupMethod: preferences.cleanupMethod, templateId: templateId ?? null, templateRevision: template?.updatedAt ?? null, checkTimes },
    history: relatedHistory(engine, input.notebookId, source?.artifactId ?? null), findings, analyzedAt: new Date().toISOString(),
  });
}
