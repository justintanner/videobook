import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Engine } from "videobook-engine";
import { runAnalysisComponentJob } from "../analysis-components.js";
import { extractFrames } from "../captions/frames.js";
import { cleanupSource } from "../video-cleanup/source.js";
import { registerJobHandler } from "../queue.js";
import { withCleanupDetector } from "../video-cleanup/detect.js";
import { cleanupSampleTimes, trackCleanupRegions, validateCleanupRegions, type CleanupBox } from "../video-cleanup/model.js";
import { installCleanupModels } from "../video-cleanup/models.js";
import { renderCleanup } from "../video-cleanup/render.js";
import { CLEANUP_DETECTION, cleanupDetectionKey, cleanupDetectionSchema, cleanupDestination, readCleanupRequest } from "../video-cleanup/service.js";
import { withLocalLease } from "./_lease.js";
import { placeRenderedCell, processRenderedVideo, writeRenderedVideo } from "./_render-output.js";

export function registerRemoveVideoGraphicsJobs(engine: Engine): void {
  registerJobHandler("install_video_cleanup_models", async (_input, ctx) => {
    await installCleanupModels(ctx.signal);
    return { installed: true };
  });
  registerJobHandler(CLEANUP_DETECTION.jobType, async (input, ctx) => {
    const assetId = String(input.sourceArtifactId);
    const source = await cleanupSource(engine, assetId);
    const interval = Number(input.interval);
    const key = cleanupDetectionKey(source.mediaHash, interval);
    if (key !== input.componentKey) throw new Error("The video changed before detection. Detect again.");
    const result = await runAnalysisComponentJob({
      engine, spec: CLEANUP_DETECTION, key, artifactId: assetId, force: input.force === true, schema: cleanupDetectionSchema,
      currentKey: async () => cleanupDetectionKey((await cleanupSource(engine, assetId)).mediaHash, interval),
      compute: () => withCleanupDetector(async (detect) => {
        const sample = cleanupSampleTimes(source.durationSeconds, interval);
        const frames: { time: number; boxes: CleanupBox[] }[] = [];
        for (const time of sample.times) {
          ctx.signal.throwIfAborted();
          const [frame] = await extractFrames(source.path, [{ time, id: "frame" }], source.durationSeconds, ctx.signal);
          if (!frame) throw new Error("Unable to sample a video frame.");
          frames.push({ time, boxes: await detect(frame.buffer) });
        }
        ctx.signal.throwIfAborted();
        return {
          value: { regions: trackCleanupRegions(frames, interval, source.durationSeconds), interval, samples: sample.times.length },
          sourceHash: source.mediaHash,
          provenance: { analyzer: CLEANUP_DETECTION.component, provider: null, model: "PP-OCRv5_mobile_det" },
        };
      }),
    });
    return result.value;
  });
  registerJobHandler("remove_video_graphics", async (input, ctx) => {
    const request = readCleanupRequest(engine, String(input.requestId));
    if (!request || request.outputArtifactId !== input.assetId) throw new Error("This removal request is no longer available.");
    const reviewedSource = async () => {
      const source = await cleanupSource(engine, request.sourceArtifactId);
      if (source.mediaHash !== request.sourceHash) throw new Error("The video changed after review. Reopen the remover and review again.");
      return source;
    };
    const result = await withLocalLease(engine, request.outputArtifactId, ctx, "render", async () => {
      const source = await reviewedSource();
      const regions = validateCleanupRegions(request.regions, source.durationSeconds);
      const scratch = await mkdtemp(join(tmpdir(), "videobook-cleanup-"));
      try {
        const outputPath = join(scratch, "cleaned.mp4");
        await renderCleanup({ source, outputPath, regions, method: request.method, signal: ctx.signal });
        await reviewedSource();
        ctx.signal.throwIfAborted();
        await writeRenderedVideo(engine, request.outputArtifactId, outputPath, source, ctx.signal);
        const provenance = await engine.files.write(request.outputArtifactId, "video-cleanup.json", JSON.stringify({ sourceArtifactId: request.sourceArtifactId, sourceHash: request.sourceHash, method: request.method, regions }));
        if (!provenance.ok) throw new Error(provenance.error.message);
        const placement = await placeRenderedCell(engine, {
          notebookId: request.notebookId, operation: "remove_video_graphics", sourceArtifactId: request.sourceArtifactId,
          outputArtifactId: request.outputArtifactId, fallbackLabel: "Cleaned video",
          destination: (notebook) => cleanupDestination(notebook, request.sourceArtifactId),
          inputs: { sourceOperation: "remove_video_graphics", sourceArtifactId: request.sourceArtifactId },
        });
        return { output_asset_id: request.outputArtifactId, cell_id: placement.cellId, address: placement.address };
      } finally { await rm(scratch, { recursive: true, force: true }); }
    });
    await processRenderedVideo(engine, String(input.bookId), request.outputArtifactId, { origin: "video-cleanup" });
    return result;
  });
}
