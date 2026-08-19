import type { Engine } from "videobook-engine";
import { splitSourceRange } from "../notebook-media-ops.js";
import { registerJobHandler } from "../queue.js";

type ExtractVideoClipPayload = {
  type: "extract_video_clip";
  sourceAssetId: string;
  startTime: number;
  endTime: number;
  title: string;
  bookId: string;
};

export function registerExtractVideoClipJob(engine: Engine): void {
  registerJobHandler("extract_video_clip", async (payload) => {
    const {
      sourceAssetId,
      startTime,
      endTime,
      title,
    } = payload as ExtractVideoClipPayload;
    return await splitSourceRange(
      engine,
      sourceAssetId,
      { startSeconds: startTime, endSeconds: endTime },
      title,
    );
  });
}
