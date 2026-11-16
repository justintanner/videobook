import { createHash } from "node:crypto";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { z } from "zod";
import { probeVideo } from "./ffmpeg.js";
import { sourceCredit } from "./graphics/credit.js";
import { graphicsTemplateImageIds, readGraphicsTemplates, watermarkTitleSlots } from "./graphics/templates.js";
import { GRAPHICS_STARTERS } from "./graphics/starters.js";
import { goalReferenceHashes } from "./goal-reference-images.js";
import { goalBrandingFindings, goalBrandingSchema, goalBrandingTitleSlots, goalSoundtrackSchema, type GoalBranding, type GoalSoundtrack } from "./goal-finish-model.js";
import type { GoalShortPlan } from "./goal-short-plan.js";
import { requireGoalShortContent, saveGoal, writeGoalShortContent, type GoalRecord } from "./goal-store.js";
import { effectiveWatermarkProfile, readWatermarkConfig } from "./watermark-config.js";

export async function captureGoalBranding(engine: Engine, sourceArtifactId: string | null): Promise<GoalBranding> {
  const config = await readWatermarkConfig(engine, "tiktok");
  const profile = effectiveWatermarkProfile(config, "tiktok");
  const templates = readGraphicsTemplates(engine);
  const templateId = templates.watermark.tiktok ?? templates.defaultId;
  const template = templates.templates.find(value => value.id === templateId) ?? null;
  const hashes = await goalReferenceHashes(engine, template ? graphicsTemplateImageIds(template.document) : []);
  const snapshot = {
    version: 1, profile, template, starterId: GRAPHICS_STARTERS.find(value => value.id === templateId)?.id ?? null,
    qrStartSeconds: config.profile?.qrStartSeconds ?? null, qrEndSeconds: config.profile?.qrEndSeconds ?? null,
    images: hashes.map(value => ({ artifactId: value.artifactId, mediaHash: value.objectHash })),
    credit: sourceArtifactId ? await sourceCredit(engine, sourceArtifactId) : null,
  };
  return goalBrandingSchema.parse({ ...snapshot, revision: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex") });
}

export async function assertGoalBrandingCurrent(engine: Engine, branding: GoalBranding): Promise<void> {
  const hashes = await goalReferenceHashes(engine, branding.images.map(value => value.artifactId));
  if (branding.images.some((value, index) => !value.mediaHash || value.mediaHash !== hashes[index]?.objectHash)) throw new Error("An image in the saved branding changed or is missing. Review the current book branding before finishing.");
}

export function goalFinishTitleSlots(engine: Engine, plan: GoalShortPlan | null) {
  const analysis = plan?.version === 5 ? plan.analysis : null;
  return analysis?.recipe.branding ? goalBrandingTitleSlots(analysis.recipe.branding, analysis.preferences.branding) : watermarkTitleSlots(engine, "tiktok");
}

export async function goalSoundtrackSource(engine: Engine, artifactId: string, expectedHash?: string, evidence?: GoalSoundtrack) {
  const artifact = engine.artifacts.get(artifactId);
  if (!artifact.ok || !["audio", "video", "final"].includes(artifact.value.kind)) throw new Error("Choose an audio or video artifact for the soundtrack.");
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findPrimaryMediaFile(manifest.value.files, artifact.value.kind);
  if (!file) throw new Error("The soundtrack media is missing.");
  if (expectedHash && file.objectHash !== expectedHash) throw new Error("The soundtrack changed. Refresh the finish settings to review its current version.");
  const streams = engine.streams.list(artifactId);
  if (!streams.ok) throw new Error(streams.error.message);
  const current = streams.value.filter(stream => stream.sourcePath === file.name && stream.objectHash === file.objectHash);
  const path = join(manifest.value.path, file.name);
  if (!current.length) {
    const facts = evidence?.artifactId === artifactId && evidence.mediaHash === file.objectHash ? evidence : await probeVideo(path);
    return { path, mediaHash: file.objectHash, hasAudio: facts.hasAudio, durationSeconds: "durationSeconds" in facts ? facts.durationSeconds : facts.duration };
  }
  return { path, mediaHash: file.objectHash, hasAudio: current.some(value => value.kind === "audio"),
    durationSeconds: Math.max(...current.map(stream => stream.durationTicks * stream.timeBase.numerator / stream.timeBase.denominator)) };
}

export async function refreshShortFinishSettings(engine: Engine, goal: GoalRecord, args: Record<string, unknown>): Promise<GoalRecord> {
  if (!["review", "completed", "failed", "interrupted"].includes(goal.status) || goal.finish?.status === "running") throw new Error("Stop the current work before refreshing finish settings.");
  const content = requireGoalShortContent(engine, goal);
  if (args.revision !== content.revision) throw new Error("The goal changed. Review its current revision first.");
  const plan = content.plan;
  if (plan?.version !== 5 || !plan.analysis) throw new Error("Analyze this goal before refreshing finish settings.");
  const { analysis } = plan;
  const branding = await captureGoalBranding(engine, analysis.source?.artifactId ?? null);
  let soundtrack: GoalSoundtrack | null = analysis.recipe.soundtrack !== undefined ? analysis.recipe.soundtrack : analysis.source ? {
    artifactId: analysis.source.artifactId, mediaHash: analysis.source.mediaHash, startSeconds: 0,
    durationSeconds: analysis.source.durationSeconds, hasAudio: analysis.source.hasAudio,
  } : null;
  if (args.audio_artifact_id !== undefined || args.audio_start_seconds !== undefined) {
    const artifactId = args.audio_artifact_id === null ? analysis.source?.artifactId : args.audio_artifact_id ?? soundtrack?.artifactId ?? analysis.source?.artifactId;
    if (!artifactId) soundtrack = null;
    else {
      const id = z.string().uuid().parse(artifactId);
      const source = await goalSoundtrackSource(engine, id);
      soundtrack = goalSoundtrackSchema.parse({ artifactId: id, mediaHash: source.mediaHash,
        startSeconds: args.audio_start_seconds ?? (id === soundtrack?.artifactId ? soundtrack.startSeconds : 0),
        durationSeconds: source.durationSeconds, hasAudio: source.hasAudio });
      if (soundtrack.startSeconds >= soundtrack.durationSeconds) throw new Error("The soundtrack start must be inside its duration.");
    }
  }
  const recipe = { ...analysis.recipe, branding, soundtrack, templateId: branding.template?.id ?? branding.starterId, templateRevision: branding.template?.updatedAt ?? null };
  if (JSON.stringify(recipe) === JSON.stringify(analysis.recipe)) return goal;
  const missingAudio = ["source", "mix"].includes(analysis.intent.audio) && !soundtrack?.hasAudio;
  const findings = analysis.findings.filter(value => value.code !== "missing-audio" && value.code !== "finish-branding");
  findings.push(...goalBrandingFindings(branding, analysis.preferences.branding, analysis.recipe.targetSeconds));
  if (missingAudio) findings.push({ code: "missing-audio", severity: "review", text: "The selected soundtrack has no audio. Choose generated sound, mute, or another soundtrack." });
  await writeGoalShortContent(engine, goal, { ...content, plan: { ...plan, analysis: { ...analysis, recipe, findings } }, revision: content.revision + 1 });
  return saveGoal(engine, { ...goal, status: "review", error: null, finish: null });
}
