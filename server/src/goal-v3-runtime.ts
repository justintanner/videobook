import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile } from "videobook-engine";
import { notebookGridTag } from "videobook-engine/notebook-grid";
import { scanNotebookMentions } from "videobook-engine/notebook-mentions";
import type { ChainStep } from "./chain-plan.js";
import { probeVideo, runFfmpeg } from "./ffmpeg.js";
import type { GoalMediaRef, GoalPlanV3 } from "./goal-plan-v3.js";
import { compileGoalV3Steps } from "./goal-plan-v3.js";
import { resolveNotebookPromptReferences } from "./notebook-reference-resolver.js";
import { assessToolCallEstimate } from "./jobs/cost-estimate-assessment.js";
import type { GoalEstimates } from "./goal-store.js";

const GOAL_MEDIA_HELP = "Mention the reference images or videos in the brief, for example /goal @a1 @a2 as ...";

function mediaKind(kind: string, cellType: string): "image" | "video" | null {
  if (kind === "image" || cellType === "image" || cellType === "generate_image") return "image";
  if (kind === "video" || kind === "final" || ["video", "generate_video", "concat", "splice", "split_video"].includes(cellType)) return "video";
  return null;
}

export async function resolveGoalMediaReferences(engine: Engine, document: NotebookDocument, brief: string): Promise<Omit<GoalMediaRef, "slot">[]> {
  if (scanNotebookMentions(brief).length === 0) throw new Error(GOAL_MEDIA_HELP);
  const resolved = resolveNotebookPromptReferences({ engine, document, prompt: brief, requireMedia: true });
  if (resolved.unresolved.length > 0) throw new Error(resolved.unresolved[0]!.message);
  const references: Omit<GoalMediaRef, "slot">[] = [];
  const seen = new Set<string>();
  for (const reference of resolved.resolved) {
    if (seen.has(reference.artifactId)) continue;
    const artifact = engine.artifacts.get(reference.artifactId);
    const cell = document.cells.find(candidate => candidate.id === reference.cellId);
    const kind = artifact.ok && cell ? mediaKind(artifact.value.kind, cell.type) : null;
    if (!artifact.ok || !cell || !kind) throw new Error(`${reference.mention} is not an image or video`);
    const manifest = await engine.files.manifest(reference.artifactId);
    const file = manifest.ok ? findPrimaryMediaFile(manifest.value.files, kind === "image" ? "image" : "video") : null;
    if (!manifest.ok || !file) throw new Error(`${reference.mention} has no readable media`);
    seen.add(reference.artifactId);
    references.push({
      kind,
      artifactId: reference.artifactId,
      cellId: cell.id,
      address: notebookGridTag(cell.slot),
      label: artifact.value.label || cell.label || reference.mention,
      objectHash: file.objectHash,
    });
  }
  if (references.length === 0) throw new Error(GOAL_MEDIA_HELP);
  return references;
}

export async function sampleGoalVideoFrames(
  engine: Engine,
  references: readonly Omit<GoalMediaRef, "slot">[],
): Promise<GoalPlanV3["sampledFrames"]> {
  const frames: GoalPlanV3["sampledFrames"] = [];
  for (const reference of references) {
    if (reference.kind !== "video") continue;
    const manifest = await engine.files.manifest(reference.artifactId);
    if (!manifest.ok) throw new Error(manifest.error.message);
    const file = findPrimaryMediaFile(manifest.value.files, "video");
    if (!file || file.objectHash !== reference.objectHash) throw new Error("A video reference changed before its frames could be inspected");
    const videoPath = join(manifest.value.path, file.name);
    const probe = await probeVideo(videoPath);
    const seconds = probe.videoDuration > 1 ? 1 : 0;
    const scratch = await mkdtemp(join(tmpdir(), "videobook-goal-frame-"));
    try {
      const framePath = join(scratch, "frame.jpg");
      await runFfmpeg(["-y", "-ss", String(seconds), "-i", videoPath, "-map", "0:v:0", "-frames:v", "1", "-q:v", "3", framePath]);
      frames.push({ artifactId: reference.artifactId, objectHash: file.objectHash, seconds });
    } finally {
      await rm(scratch, { recursive: true, force: true });
    }
  }
  return frames;
}

function estimateInput(engine: Engine, plan: GoalPlanV3, step: ChainStep): Record<string, unknown> {
  const videoRefs = plan.video.videoRefs.map(reference => reference.artifactId);
  return {
    book_id: engine.book.get().bookId,
    ...step.params,
    ...(step.id === "video" && videoRefs.length > 0 ? { video_refs: videoRefs } : {}),
  };
}

export async function estimateGoalV3(engine: Engine, plan: GoalPlanV3): Promise<GoalEstimates> {
  const [scene, video] = compileGoalV3Steps(plan);
  const priced = await Promise.all([scene, video].map(async step => {
    const estimate = await assessToolCallEstimate(engine, step!.tool, estimateInput(engine, plan, step!));
    return { usd: estimate.available ? estimate.usd ?? null : null, warnings: estimate.warnings };
  }));
  const frame = priced[0]!;
  const videos = priced[1]!;
  const storyboards = { usd: 0, warnings: [] as string[] };
  const parts = [frame, storyboards, videos];
  return {
    frame,
    storyboards,
    videos,
    total: {
      usd: parts.every(part => part.usd !== null) ? parts.reduce((sum, part) => sum + (part.usd ?? 0), 0) : null,
      warnings: [...new Set(parts.flatMap(part => part.warnings))],
    },
  };
}

export function goalMediaCharacters(references: readonly GoalMediaRef[]) {
  return references.filter(reference => reference.kind === "image").map(reference => ({
    artifactId: reference.artifactId,
    cellId: reference.cellId,
    address: reference.address,
    label: reference.label,
  }));
}
