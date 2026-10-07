import type { Engine, NotebookDocument } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { getChainRun } from "./chain-executor.js";
import type { ChainStep } from "./chain-plan.js";
import { compileFrameSteps, compileStoryboardSteps, goalStillPrompt, type GoalCharacter, type GoalPlan, type GoalStillStage } from "./goal-plan.js";
import type { GoalRecord, GoalStageOutput, GoalStillAttempt } from "./goal-store.js";

export function goalStillAttempts(goal: GoalRecord, plan: GoalPlan, stage: GoalStillStage, chainId: string, steps: readonly ChainStep[], createdAt: string, feedback: string | null = null): GoalStillAttempt[] {
  return [...(goal.stages[stage]?.attempts ?? []), ...steps.map(step => {
    const index = stage === "frame" ? 0 : Number(step.id.slice("storyboard".length)) - 1;
    return {
      stage, index, chainId, stepId: step.id, artifactId: null, cellId: null,
      basePrompt: goalStillPrompt(plan, stage, index), feedback,
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

export function goalStillStaleReason(engine: Engine, goal: GoalRecord, document: NotebookDocument, plan: GoalPlan, characters: readonly GoalCharacter[], stage: GoalStillStage, output: GoalStageOutput): string | null {
  const name = stage === "frame" ? "Full frame" : `${output.index >= plan.shots.length ? "Ending storyboard" : "Storyboard"} ${output.index % plan.shots.length + 1}`;
  const run = goal.stages[stage];
  const attempt = run?.attempts?.find(item => item.index === output.index && item.artifactId === output.artifactId);
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
  return source?.params.prompt === compiled?.params.prompt || source?.params.prompt === legacyStillPrompt(plan, characters, stage, output.index) ? null : promptError;
}
