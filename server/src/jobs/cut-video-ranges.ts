import type { Engine } from "videobook-engine";
import { concatSourceRanges, splitSourceRange } from "../notebook-media-ops.js";
import { registerJobHandler } from "../queue.js";
import type { VideoRange } from "../video-cut-ranges.js";

export type CutVideoRangesPayload = {
  type: "cut_video_ranges";
  sourceAssetId: string;
  outputs: Array<{ title: string; keepRanges: VideoRange[] }>;
  bookId: string;
};

export type CutVideoRangesResult = Array<{ artifactId: string; durationSeconds: number }>;

async function cutOutput(
  engine: Engine,
  sourceAssetId: string,
  output: CutVideoRangesPayload["outputs"][number],
): Promise<{ artifactId: string; durationSeconds: number }> {
  return output.keepRanges.length === 1
    ? await splitSourceRange(engine, sourceAssetId, output.keepRanges[0]!, output.title)
    : await concatSourceRanges(engine, sourceAssetId, output.keepRanges, output.title);
}

export function registerCutVideoRangesJob(engine: Engine): void {
  registerJobHandler("cut_video_ranges", async (payload): Promise<CutVideoRangesResult> => {
    const { sourceAssetId, outputs } = payload as CutVideoRangesPayload;
    const results: CutVideoRangesResult = [];
    for (const output of outputs) results.push(await cutOutput(engine, sourceAssetId, output));
    return results;
  });
}
