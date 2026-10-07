import { join } from "node:path";
import sharp from "sharp";
import { v7 as uuidv7 } from "uuid";
import type { Engine } from "videobook-engine";
import { compileFrameSteps, compileStoryboardSteps, compileVideoSteps, goalPlanSchema, type GoalGenerationStage, type GoalPlan } from "./goal-plan.js";
import { requireGoalContent, readGoal, saveGoal, type GoalStageRun } from "./goal-store.js";
import { preflightChainPlan } from "./chain-plan.js";
import type { ChainRunRecord } from "./chain-executor.js";
import { getAllToolDefs } from "./tools/index.js";
import { placeChainGeneration } from "./chain-generation.js";
import { copyVideoFixture } from "./test-media-fixtures.js";
import { probeVideo } from "./ffmpeg.js";

export function goalTestPlan(count = 3): GoalPlan {
  return goalPlanSchema.parse({
    version: 2, title: "The skateboard champion", continuity: "Character 1 is a scruffy terrier in a red helmet. Character 2 is a tabby in a blue scarf. Both share a sunny park, a blue skateboard and warm comic cinema.", aspectRatio: "16:9",
    frame: { prompt: "Both characters stand beside the skateboard in the sunny park, full bodies visible." },
    shots: Array.from({ length: count }, (_, index) => ({
      title: `Park adventure ${index + 1}`, storyboardPrompt: `Character 1 balances on the skateboard while Character 2 watches, composition ${index + 1}.`,
      videoPrompt: `Character 1 glides past Character 2, then comes to a comic stop. Tracking camera, birds and squeaking wheels, action ${index + 1}.`, durationSeconds: 10,
    })),
  });
}

async function goalTestImage(engine: Engine, label: string, color = "#cf593b"): Promise<string> {
  const created = await engine.artifacts.create("image", label);
  if (!created.ok) throw new Error(created.error.message);
  const bytes = await sharp({ create: { width: 96, height: 128, channels: 3, background: color } }).png().toBuffer();
  const written = await engine.files.write(created.value.artifactId, "original.png", bytes);
  if (!written.ok) throw new Error(written.error.message);
  return created.value.artifactId;
}

export async function goalTestCharacters(engine: Engine, notebookId: string): Promise<string[]> {
  const ids: string[] = [];
  for (const [index, color] of ["#cf593b", "#2878b4"].entries()) {
    const artifactId = await goalTestImage(engine, `Character ${index + 1}`, color);
    const cell = engine.notebooks.createCell({ type: "image", label: `Character ${index + 1}`, slot: { row: 0, column: index }, outputArtifactId: artifactId });
    const inserted = await engine.notebooks.insertCell(notebookId, cell);
    if (!inserted.ok) throw new Error(inserted.error.message);
    ids.push(artifactId);
  }
  return ids;
}

export async function goalTestVideo(engine: Engine, root: string, color: string): Promise<string> {
  const path = join(root, `${uuidv7()}.mp4`);
  await copyVideoFixture({ width: 160, height: 90, durationSec: 4, fps: 10, source: "color", color, audio: { frequency: 440 } }, path);
  const created = await engine.artifacts.create("video", color);
  if (!created.ok) throw new Error(created.error.message);
  const artifactId = created.value.artifactId;
  const written = await engine.files.writeFromPath(artifactId, "original.mp4", path);
  if (!written.ok) throw new Error(written.error.message);
  const probe = await probeVideo(path);
  const metadata = await engine.metadata.artifacts.write(artifactId, "original", { duration: probe.duration, width: probe.width, height: probe.height, fps: probe.fps, hasAudio: probe.hasAudio });
  if (!metadata.ok) throw new Error(metadata.error.message);
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const stream = probe.videoStream!;
  const registered = await engine.streams.register({ artifactId, sourcePath: "original.mp4", objectHash: manifest.value.files[0]!.objectHash, streamIndex: stream.index, kind: "video", codec: stream.codec, timeBase: stream.timeBase, durationTicks: stream.durationTicks, video: stream.video });
  if (!registered.ok) throw new Error(registered.error.message);
  return artifactId;
}

export async function seedGoalStage(engine: Engine, goalId: string, stage: GoalGenerationStage, options: { failedIndex?: number; indexes?: number[]; videoIds?: string[] } = {}): Promise<string> {
  const goal = readGoal(engine, goalId);
  const content = requireGoalContent(engine, goal);
  const plan = goalPlanSchema.parse(content.plan);
  const frame = goal.stages.frame?.outputs[0]?.address ?? content.characters[0]!.address;
  const storyboards = plan.shots.map((_, index) => goal.stages.storyboards?.outputs.find(output => output.index === index)?.address ?? frame);
  const endings = plan.frameContinuity ? plan.shots.map((_, index) => goal.stages.storyboards?.outputs.find(output => output.index === index + plan.shots.length)?.address ?? frame) : [];
  const steps = stage === "frame" ? compileFrameSteps(plan, content.characters)
    : stage === "storyboards" ? compileStoryboardSteps(plan, content.characters, frame, options.indexes)
      : compileVideoSteps(goalId, plan, content.characters, storyboards, endings);
  const defs = getAllToolDefs(engine);
  const checked = await preflightChainPlan({ action: "run", version: 1, book_id: goal.bookId, notebook_id: goal.notebookId, steps }, {
    engine, bookId: goal.bookId, notebookId: goal.notebookId, toolSchemas: new Map(defs.map(def => [def.name, def.schema])), autoApplyTools: new Set(),
    effectForTool: name => name === "assemble_goal" ? "mutation" : "generation",
  });
  if (!checked.ok) throw new Error(JSON.stringify(checked));
  const chainId = uuidv7();
  const timestamp = new Date().toISOString();
  const records: ChainRunRecord["steps"] = [];
  for (const [position, step] of checked.plan.steps.entries()) {
    const index = step.id === "frame" ? 0 : Number(/\d+$/u.exec(step.id)?.[0]) - 1;
    const fails = step.id === "assemble" || options.failedIndex === position;
    const skipped = options.failedIndex !== undefined && position > options.failedIndex;
    let outputs: Record<string, unknown> | null = null;
    if (!fails && !skipped) {
      const artifactId = options.videoIds?.[index] ?? await goalTestImage(engine, step.id, index % 2 ? "#2878b4" : "#cf593b");
      const placed = await placeChainGeneration({ engine, notebookId: goal.notebookId, tool: step.tool, placement: stage === "videos" ? "generate_video" : "generate_image", params: step.params, artifactId, runId: `${chainId}:${step.id}`, pins: step.pins });
      outputs = { asset_id: artifactId, [stage === "videos" ? "vid_asset_id" : "img_asset_id"]: artifactId, cell_id: placed.outputCellId, address: placed.address, status: "completed" };
    }
    records.push({ id: step.id, tool: step.tool, params: step.params, pins: step.pins,
      status: skipped ? "skipped" : fails ? "failed" : "completed", outputs, error: fails ? "Fixture stage interrupted" : null,
      childJobIds: [], autoApply: false, effect: step.effect, requiresApproval: step.requiresApproval, review: null,
      approval: step.requiresApproval ? { actor: "chat", approvedAt: timestamp, estimateUsd: null, estimateUnavailable: true } : null,
    });
  }
  const failed = records.some(step => step.status === "failed");
  const chain: ChainRunRecord = { kind: "chain-run", chainId, bookId: goal.bookId, notebookId: goal.notebookId, requestId: null, fingerprint: `fixture-${chainId}`, status: failed ? "failed" : "completed", createdAt: timestamp, updatedAt: timestamp, error: failed ? "Fixture stage interrupted" : null, autoApply: false, effect: "generation", awaitingStepId: null, steps: records };
  const store = engine.settings.get<{ runs: Record<string, ChainRunRecord>; requestIndex: Record<string, string> }>("application.chain-runs.v1") ?? { runs: {}, requestIndex: {} };
  const written = engine.settings.set("application.chain-runs.v1", { ...store, runs: { ...store.runs, [chainId]: chain } });
  if (!written.ok) throw new Error(written.error.message);
  const previous = goal.stages[stage];
  const run: GoalStageRun = { chainId, revision: content.revision, approvedAt: timestamp, shotIndexes: stage === "frame" ? [0] : options.indexes ?? plan.shots.map((_, index) => index), outputs: previous?.outputs ?? [], previousChainIds: previous ? [...previous.previousChainIds, previous.chainId] : [] };
  saveGoal(engine, { ...goal, status: "running", stage, chainId, stages: { ...goal.stages, [stage]: run }, ...(stage === "videos" ? { clipIds: plan.shots.map(() => uuidv7()), trackId: engine.sequences.getPrimary().tracks.find(track => track.kind === "video")!.trackId } : {}) });
  return chainId;
}
