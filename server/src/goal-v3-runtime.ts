import { join } from "node:path";
import { v7 as uuidv7 } from "uuid";
import type { Engine, NotebookCell, NotebookDocument } from "videobook-engine";
import { findPrimaryMediaFile, nextHorizontalSlotFrom } from "videobook-engine";
import { notebookGridTag, notebookOccupiedSlots } from "videobook-engine/notebook-grid";
import { scanNotebookMentions } from "videobook-engine/notebook-mentions";
import type { ChainStep } from "./chain-plan.js";
import { probeVideo } from "./ffmpeg.js";
import type { GoalMediaRef, GoalPlanV3, GoalSceneFrame } from "./goal-plan-v3.js";
import { closestGoalAspectRatio, compileGoalV3Steps } from "./goal-plan-v3.js";
import { captureFrame } from "./notebook-media-ops.js";
import { EXTRACT_FRAME_OUTPUT_ROLE } from "./notebook-cell-outputs.js";
import { mutateNotebook } from "./notebook-mutations.js";
import { slotRight } from "./notebook-placement.js";
import { notebookCellFingerprint } from "./jobs/run-notebook.js";
import { queue } from "./queue.js";
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

async function frameImageFile(engine: Engine, artifactId: string): Promise<{ path: string; objectHash: string }> {
  const manifest = await engine.files.manifest(artifactId);
  if (!manifest.ok) throw new Error(manifest.error.message);
  const file = findPrimaryMediaFile(manifest.value.files, "image");
  if (!file) throw new Error("The scene frame has no image file");
  return { path: join(manifest.value.path, file.name), objectHash: file.objectHash };
}

async function insertSceneFrameCell(engine: Engine, notebookId: string, video: Omit<GoalMediaRef, "slot">, artifactId: string, atSeconds: number): Promise<NotebookCell> {
  const placed: { cell: NotebookCell | null } = { cell: null };
  const runId = uuidv7();
  const result = await mutateNotebook(engine, notebookId, "goal_scene_frame", (notebook) => {
    const anchor = notebook.cells.find(cell => cell.id === video.cellId);
    if (!anchor) throw new Error(`${video.address} was removed`);
    const cell = engine.notebooks.createCell({
      type: "image",
      label: `Frame at ${atSeconds}s`,
      slot: nextHorizontalSlotFrom(slotRight(anchor.slot), notebookOccupiedSlots(notebook.cells)),
      outputArtifactId: artifactId,
      inputs: { mediaRole: EXTRACT_FRAME_OUTPUT_ROLE, frameMode: "time", timestampSeconds: atSeconds, atSeconds, sourceCellId: anchor.id, state: "completed" },
    });
    placed.cell = cell;
    const completedAt = new Date().toISOString();
    return {
      ...notebook,
      cells: [...notebook.cells, cell],
      edges: [...notebook.edges, engine.notebooks.createEdge({ source: anchor.id, target: cell.id, targetInput: "segment" })],
      execution: {
        ...(notebook.execution ?? {}),
        [cell.id]: { fingerprint: notebookCellFingerprint(notebook, cell), status: "completed", runId, outputArtifactId: artifactId, completedAt, updatedAt: completedAt, tool: "ffmpeg" },
      },
    };
  }, { sourceCellId: video.cellId, runId }, { artifactId });
  if (!result.ok) throw new Error(result.error.message);
  if (!placed.cell) throw new Error("The scene frame could not be placed");
  return placed.cell;
}

export async function captureGoalSceneFrame(engine: Engine, notebookId: string, references: readonly Omit<GoalMediaRef, "slot">[]): Promise<GoalSceneFrame | null> {
  const video = references.find(reference => reference.kind === "video");
  if (!video) return null;
  const captured = await captureFrame(engine, video.artifactId, { role: "time", timestampSeconds: 1, title: `${video.address} · scene frame` });
  const file = await frameImageFile(engine, captured.artifactId);
  const probe = await probeVideo(file.path);
  await queue.enqueue(`process-image-${captured.artifactId}`, {
    type: "process_image", assetId: captured.artifactId, bookId: engine.book.get().bookId, extension: ".jpg",
    provenance: { origin: "extract_frame", sourceArtifactId: video.artifactId, frameMode: "time", atSeconds: captured.atSeconds },
  });
  const cell = await insertSceneFrameCell(engine, notebookId, video, captured.artifactId, captured.atSeconds);
  return {
    reference: {
      kind: "image", artifactId: captured.artifactId, cellId: cell.id, address: notebookGridTag(cell.slot),
      label: cell.label ?? "Scene frame", objectHash: file.objectHash,
    },
    seconds: captured.atSeconds,
    aspectRatio: closestGoalAspectRatio(probe.width, probe.height),
  };
}

function estimateInput(engine: Engine, plan: GoalPlanV3, step: ChainStep): Record<string, unknown> {
  const images = (step.id === "video" ? plan.video.imageRefs : plan.scene.imageRefs).map(reference => reference.artifactId);
  const videos = step.id === "video" ? plan.video.videoRefs.map(reference => reference.artifactId) : [];
  return {
    book_id: engine.book.get().bookId,
    ...step.params,
    refs: { image: images, video: videos },
    ...(step.id === "video" && images.length + videos.length > 0 ? { mode: "r2v" } : {}),
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
