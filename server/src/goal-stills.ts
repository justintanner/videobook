import { resolveNotebookCellArtifactId, type Engine, type NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { getChainRun } from "./chain-executor.js";
import type { ChainStep } from "./chain-plan.js";
import { compileFrameSteps, compileStoryboardSteps, goalStillPrompt, type GoalCharacter, type GoalPlan, type GoalStillStage, type GoalGenerationStage } from "./goal-plan.js";
import type { GoalPlanV3 } from "./goal-plan-v3.js";
import type { GoalRecord, GoalStageOutput, GoalStillAttempt } from "./goal-store.js";
import { goalReferenceHashes } from "./goal-reference-images.js";

function goalStepIndex(stage: GoalGenerationStage, stepId: string): number {
  if (stage === "frame" || stepId === "frame" || stepId === "scene" || stepId === "video") return 0;
  return Number(/\d+$/u.exec(stepId)?.[0]) - 1;
}

export async function goalV3Fingerprint(engine: Engine, plan: GoalPlanV3, stage: "frame" | "videos", sceneArtifactId: string | null): Promise<string> {
  const ids = stage === "frame"
    ? plan.scene.imageRefs.map(reference => reference.artifactId)
    : [...plan.video.imageRefs, ...plan.video.videoRefs].map(reference => reference.artifactId);
  return JSON.stringify({
    prompt: stage === "frame" ? plan.scene.prompt : plan.video.prompt,
    settings: stage === "frame"
      ? { model: plan.scene.model, aspectRatio: plan.scene.aspectRatio, resolution: plan.scene.resolution, outputFormat: plan.scene.outputFormat }
      : { aspectRatio: plan.video.aspectRatio, resolution: plan.video.resolution, duration: plan.video.durationSeconds, audio: plan.video.generateAudio, outputFormat: plan.video.outputFormat },
    references: await goalReferenceHashes(engine, ids),
    ...(stage === "videos" ? { sceneArtifactId } : {}),
  });
}

export async function goalStageFingerprint(engine: Engine, goal: GoalRecord, plan: GoalPlan, characters: readonly GoalCharacter[], stage: GoalGenerationStage, index: number): Promise<string> {
  const ids = characters.map(character => character.artifactId);
  if (stage !== "frame") ids.push(goal.stages.frame?.outputs[0]?.artifactId ?? "");
  if (stage === "videos") {
    ids.push(goal.stages.storyboards?.outputs.find(output => output.index === index)?.artifactId ?? "");
    if (plan.frameContinuity) ids.push(goal.stages.storyboards?.outputs.find(output => output.index === index + plan.shots.length)?.artifactId ?? "");
  }
  return JSON.stringify({
    prompt: stage === "videos" ? plan.shots[index]?.videoPrompt : goalStillPrompt(plan, stage, index),
    aspectRatio: plan.aspectRatio, style: { id: plan.style.id, options: Object.entries(plan.style.options).sort() },
    referenceRoles: plan.referenceRoles ?? [], references: await goalReferenceHashes(engine, ids),
    ...(stage === "videos" ? { duration: plan.shots[index]?.durationSeconds, resolution: plan.videoResolution, audio: true }
      : { model: plan.imageModel, resolution: plan.imageResolution, ...(stage === "frame" ? { continuity: plan.continuity } : { layout: plan.storyboardLayout ?? "four-panel" }) }),
  });
}

export async function goalAttemptFingerprints(engine: Engine, goal: GoalRecord, plan: GoalPlan, characters: readonly GoalCharacter[], stage: GoalGenerationStage, steps: readonly ChainStep[]): Promise<Record<string, string>> {
  return Object.fromEntries(await Promise.all(steps.filter(step => step.id !== "assemble").map(async step => [step.id, await goalStageFingerprint(engine, goal, plan, characters, stage, goalStepIndex(stage, step.id))])));
}

export function goalStageAttempts(engine: Engine, goal: GoalRecord, stage: GoalGenerationStage): GoalStillAttempt[] {
  const run = goal.stages[stage];
  const attempts = [...(run?.attempts ?? [])];
  if (!run || stage !== "videos") return attempts;
  for (const chainId of [...run.previousChainIds, run.chainId]) {
    for (const step of getChainRun(engine, chainId)?.steps ?? []) {
      const artifactId = step.outputs?.asset_id ?? step.outputs?.vid_asset_id;
      if (!/^shot\d+$/u.test(step.id) || step.status !== "completed" || typeof artifactId !== "string" || attempts.some(attempt => attempt.chainId === chainId && attempt.stepId === step.id)) continue;
      attempts.push({
        stage, index: goalStepIndex(stage, step.id), chainId, stepId: step.id, artifactId,
        cellId: typeof step.outputs?.cell_id === "string" ? step.outputs.cell_id : null,
        basePrompt: typeof step.params.prompt === "string" ? step.params.prompt.split("\n\n")[0]! : "",
        feedback: null, parentArtifactId: null, frameArtifactId: null, createdAt: run.approvedAt,
      });
    }
  }
  return attempts;
}

export function goalStillAttempts(goal: GoalRecord, plan: GoalPlan, stage: GoalGenerationStage, chainId: string, steps: readonly ChainStep[], createdAt: string, feedback: string | null = null, fingerprints?: Record<string, string>, history = goal.stages[stage]?.attempts ?? []): GoalStillAttempt[] {
  return [...history, ...steps.filter(step => step.id !== "assemble").map(step => {
    const index = goalStepIndex(stage, step.id);
    return {
      stage, index, chainId, stepId: step.id, artifactId: null, cellId: null,
      basePrompt: stage === "videos" ? plan.shots[index]!.videoPrompt : goalStillPrompt(plan, stage, index), feedback,
      ...(fingerprints?.[step.id] ? { fingerprint: fingerprints[step.id] } : {}),
      ...(stage === "storyboards" && index < plan.shots.length ? { storyboardLayout: plan.storyboardLayout ?? "four-panel" as const } : {}),
      parentArtifactId: feedback ? goal.stages[stage]?.outputs.find(output => output.index === index)?.artifactId ?? null : null,
      frameArtifactId: stage === "storyboards" ? goal.stages.frame?.outputs[0]?.artifactId ?? null : null,
      createdAt,
    };
  })];
}

function legacyStillPrompt(plan: GoalPlan, characters: readonly GoalCharacter[], stage: GoalStillStage, index: number): string {
  const references = characters.map((character, position) => `@image${position + (stage === "storyboards" ? 2 : 1)} is Character ${position + 1}: ${character.label.replace(/@[\p{L}\p{N}_-]+/gu, "").slice(0, 160)}`);
  if (stage === "frame") return `${plan.continuity}\n\n${plan.frame.prompt}\n\nReferences: ${references.join("; ")}.`;
  references.unshift("@image1 is the approved full frame; preserve its setting and visual style");
  const shotIndex = index % plan.shots.length;
  const shot = plan.shots[shotIndex]!;
  const next = plan.shots[shotIndex + 1];
  const ending = `Create one still image of the final moment of this shot, with the characters in their ending poses. ${shot.endingPrompt ?? shot.videoPrompt}${next ? `\nPrepare a natural transition into the next shot's opening composition: ${next.storyboardPrompt}` : "\nShow the final payoff with a clear, settled composition."}`;
  return `${plan.continuity}\n\nShot ${shotIndex + 1}: ${shot.title}\n${index < plan.shots.length ? shot.storyboardPrompt : ending}\n\nReferences: ${references.join("; ")}.`;
}

function preStyleStillPrompt(plan: GoalPlan, characters: readonly GoalCharacter[], stage: GoalStillStage, index: number): string {
  const references = characters.map((_, position) => `@image${position + (stage === "storyboards" ? 2 : 1)} is Character ${position + 1}`);
  if (stage === "frame") return `${plan.continuity}\n\n${plan.frame.prompt}\n\nReferences: ${references.join("; ")}.`;
  references.unshift("@image1 is the full frame; keep its characters, setting and style");
  const shot = plan.shots[index % plan.shots.length]!;
  return `One ending frame. ${shot.endingPrompt ?? `Final moment: ${shot.videoPrompt}`}\n\nReferences: ${references.join("; ")}.`;
}

export async function goalStillStaleReason(engine: Engine, goal: GoalRecord, document: NotebookDocument, plan: GoalPlan, characters: readonly GoalCharacter[], stage: GoalGenerationStage, output: GoalStageOutput): Promise<string | null> {
  const cell = document.cells.find(candidate => candidate.id === output.cellId);
  if (!cell || resolveNotebookCellArtifactId(document, cell) !== output.artifactId) return "The selected output changed or was removed. Choose another version or regenerate it.";
  if (characters.some(character => !document.cells.some(candidate => candidate.id === character.cellId && resolveNotebookCellArtifactId(document, candidate) === character.artifactId))) return "A source reference changed or was removed.";
  const attempt = goalStageAttempts(engine, goal, stage).find(item => item.index === output.index && item.artifactId === output.artifactId);
  if (attempt?.fingerprint && attempt.fingerprint !== await goalStageFingerprint(engine, goal, plan, characters, stage, output.index)) return `${stage === "frame" ? "Scene" : stage === "storyboards" ? "Storyboard" : "Video"} uses older settings, prompts or references. Revise or regenerate it.`;
  if (stage !== "frame") {
    const frame = goal.stages.frame?.outputs[0];
    if (!frame || await goalStillStaleReason(engine, goal, document, plan, characters, "frame", frame)) return "The scene has changed. Refresh it before continuing.";
  }
  if (stage === "videos") {
    const indexes = [output.index, ...(plan.frameContinuity ? [output.index + plan.shots.length] : [])];
    for (const index of indexes) {
      const board = goal.stages.storyboards?.outputs.find(item => item.index === index);
      if (!board || await goalStillStaleReason(engine, goal, document, plan, characters, "storyboards", board)) return "The storyboard has changed. Refresh it before generating video.";
    }
    if (attempt && !attempt.fingerprint) {
      const step = getChainRun(engine, attempt.chainId)?.steps.find(item => item.id === attempt.stepId);
      const expected = indexes.map(index => goal.stages.storyboards?.outputs.find(item => item.index === index)?.artifactId);
      if (expected.some((id, index) => id !== step?.pins[index]?.artifactId)) return "Video uses an older storyboard. Revise or regenerate it.";
    }
    return attempt && attempt.basePrompt !== plan.shots[output.index]?.videoPrompt ? "Video uses older directions. Revise or regenerate it." : null;
  }
  if (attempt?.fingerprint) return null;
  const name = stage === "frame" ? "Full frame" : `${output.index >= plan.shots.length ? "Ending frame" : "Storyboard"} ${output.index % plan.shots.length + 1}`;
  const run = goal.stages[stage];
  if (stage === "storyboards" && output.index < plan.shots.length && attempt?.storyboardLayout !== (plan.storyboardLayout ?? "four-panel")) {
    return `${name} is a legacy single-frame preview. Regenerate or revise it to create a four-panel storyboard.`;
  }
  const promptError = `${name} was made from an older prompt. Regenerate or revise it, or restore the prompt.`;
  const frameError = `${name} was made from an older full frame. Regenerate the storyboards.`;
  if (attempt) {
    if (attempt.basePrompt !== goalStillPrompt(plan, stage, output.index)) return promptError;
    if (stage === "storyboards" && attempt.frameArtifactId !== goal.stages.frame?.outputs[0]?.artifactId) return frameError;
    return null;
  }
  const source = run && [...run.previousChainIds, run.chainId].flatMap(id => getChainRun(engine, id)?.steps ?? [])
    .find(step => step.id === (stage === "frame" ? "frame" : `storyboard${output.index + 1}`) && (step.outputs?.asset_id ?? step.outputs?.img_asset_id) === output.artifactId);
  const frameOutput = goal.stages.frame?.outputs[0];
  if (stage === "storyboards" && source?.pins[0]?.artifactId !== frameOutput?.artifactId) return frameError;
  const frameCell = document.cells.find(cell => cell.id === frameOutput?.cellId);
  const compiled = stage === "frame" ? compileFrameSteps(plan, characters)[0]!
    : compileStoryboardSteps(plan, characters, frameCell ? notebookGridTag(frameCell.slot) : "", [output.index % plan.shots.length])
      .find(step => step.id === `storyboard${output.index + 1}`);
  return source?.params.prompt === compiled?.params.prompt || plan.style.id === "cinematic" && (
    source?.params.prompt === legacyStillPrompt(plan, characters, stage, output.index)
    || source?.params.prompt === preStyleStillPrompt(plan, characters, stage, output.index)
  ) ? null : promptError;
}
