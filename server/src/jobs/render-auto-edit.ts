import { rm } from "node:fs/promises";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import {
  AUTO_EDIT_RENDER_JOB,
  AUTO_EDIT_SOURCE_OPERATION,
  autoEditDestination,
  readAutoEditRenderRequest,
  readAutoEditSource,
  type AutoEditRenderRequest,
} from "../auto-edit/drafts.js";
import { checkSegmentPlan, secondsToFrame, type SegmentPlan, type SegmentSource } from "../auto-edit/plan.js";
import { renderSegmentPlan } from "../auto-edit/render.js";
import { buildAutoEditPlan, type AutoEditCue } from "../auto-edit/style.js";
import { probeVideo, type ProbeResult } from "../ffmpeg.js";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";
import type { BuiltinSfxCue } from "../sound-effects/mix.js";
import { withLocalLease } from "./_lease.js";
import { placeRenderedCell, processRenderedVideo, writeRenderedVideo } from "./_render-output.js";

interface RenderAutoEditPayload {
  bookId: string;
  assetId: string;
  requestId: string;
}

const SNAPSHOT_NAME = ".auto-edit-source.mp4";
const OUTPUT_NAME = ".auto-edit-render.mp4";

function displaySize(probe: ProbeResult): { width: number; height: number } {
  const quarterTurn = Math.abs(probe.videoStream?.video?.rotationDegrees ?? 0) % 180 === 90;
  return quarterTurn
    ? { width: probe.height, height: probe.width }
    : { width: probe.width, height: probe.height };
}

function toMixCues(cues: readonly AutoEditCue[]): BuiltinSfxCue[] {
  return cues.map((cue) => ({
    sound: cue.sound,
    startSeconds: cue.startSeconds,
    gain: Math.min(1, Math.max(0, cue.volume / 100)),
  }));
}

function rebuildPlan(
  request: AutoEditRenderRequest,
  probe: ProbeResult,
): { plan: SegmentPlan; cues: AutoEditCue[] } {
  if (request.mode === "anchors" && request.anchors && request.sections) {
    const size = displaySize(probe);
    const fps = probe.fps;
    const frames = Math.max(2, secondsToFrame(probe.videoDuration, fps));
    const source: SegmentSource = {
      artifactId: request.sourceArtifactId,
      sourceHash: request.sourceHash,
      fps,
      frames,
      width: size.width,
      height: size.height,
      hasAudio: probe.hasAudio,
    };
    const built = buildAutoEditPlan(source, request.anchors, request.sections);
    return { plan: built.plan, cues: built.cues };
  }
  const issues = checkSegmentPlan(request.plan);
  if (issues.length > 0) {
    throw new Error(issues[0]!.message);
  }
  return { plan: request.plan, cues: request.cues };
}

async function renderCopy(
  engine: Engine,
  payload: RenderAutoEditPayload,
  renderedAt: string,
  signal: AbortSignal,
) {
  const request = readAutoEditRenderRequest(engine, payload.requestId);
  if (!request || request.outputArtifactId !== payload.assetId) {
    throw new Error("This auto-edit render request is no longer available. Start a new render.");
  }
  const source = await readAutoEditSource(engine, request.sourceArtifactId, request.sourceHash);
  const copied = await engine.files.copy(request.sourceArtifactId, source.file.name, request.outputArtifactId, SNAPSHOT_NAME);
  if (!copied.ok) throw new Error(copied.error.message);
  const manifest = await engine.files.manifest(request.outputArtifactId, { includeDotfiles: true });
  if (!manifest.ok) throw new Error(manifest.error.message);
  const snapshotHash = manifest.value.files.find((file) => file.name === SNAPSHOT_NAME)?.objectHash;
  if (snapshotHash !== request.sourceHash) {
    await engine.files.delete(request.outputArtifactId, SNAPSHOT_NAME);
    throw new Error("The source video changed since review. Reload auto-edit before rendering.");
  }
  const inputPath = join(manifest.value.path, SNAPSHOT_NAME);
  const outputPath = join(manifest.value.path, OUTPUT_NAME);
  try {
    const probe = await probeVideo(inputPath, { signal });
    const { plan, cues } = rebuildPlan(request, probe);
    const rendered = await renderSegmentPlan(plan, inputPath, outputPath, signal, {
      cues: toMixCues(cues),
    });
    await readAutoEditSource(engine, request.sourceArtifactId, request.sourceHash);
    signal.throwIfAborted();
    const writtenProbe = await writeRenderedVideo(
      engine,
      request.outputArtifactId,
      outputPath,
      { artifactId: source.artifactId, durationSeconds: source.durationSeconds, fps: source.fps },
      signal,
    );
    const provenance = await engine.metadata.artifacts.write(request.outputArtifactId, "auto-edit", {
      origin: "auto-edit",
      requestId: request.requestId,
      sourceArtifactId: request.sourceArtifactId,
      sourceHash: request.sourceHash,
      plan,
      cues,
      rendered_at: renderedAt,
    });
    if (!provenance.ok) throw new Error(provenance.error.message);
    signal.throwIfAborted();
    const placement = await placeRenderedCell(engine, {
      notebookId: request.notebookId,
      operation: AUTO_EDIT_RENDER_JOB,
      sourceArtifactId: request.sourceArtifactId,
      outputArtifactId: request.outputArtifactId,
      fallbackLabel: "Auto-edit",
      destination: (notebook) => autoEditDestination(notebook, request.sourceArtifactId),
      inputs: { sourceOperation: AUTO_EDIT_SOURCE_OPERATION, sourceArtifactId: request.sourceArtifactId },
    });
    return {
      result: {
        output_asset_id: request.outputArtifactId,
        cell_id: placement.cellId,
        address: placement.address,
        duration: writtenProbe.videoDuration,
        frames: rendered.frames,
      },
      plan,
      cues,
    };
  } finally {
    await rm(outputPath, { force: true });
    await engine.files.delete(request.outputArtifactId, SNAPSHOT_NAME);
  }
}

async function runRenderAutoEdit(engine: Engine, payload: RenderAutoEditPayload, ctx: JobHandlerContext) {
  const renderedAt = new Date().toISOString();
  const rendered = await withLocalLease(engine, payload.assetId, ctx, "render", () =>
    renderCopy(engine, payload, renderedAt, ctx.signal),
  );
  await processRenderedVideo(engine, payload.bookId, rendered.result.output_asset_id, {
    origin: "auto-edit",
    plan: rendered.plan,
    cues: rendered.cues,
    rendered_at: renderedAt,
  });
  return rendered.result;
}

export function registerRenderAutoEditJob(engine: Engine): void {
  registerJobHandler(AUTO_EDIT_RENDER_JOB, async (input, ctx) =>
    runRenderAutoEdit(engine, input as unknown as RenderAutoEditPayload, ctx),
  );
}
