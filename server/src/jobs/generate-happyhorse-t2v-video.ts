import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { buildHappyHorseT2vPayload } from "../payload-builders.js";

type GenerateHappyhorseT2vVideoPayload = {
  type: "generate_happyhorse_t2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  resolution?: "720p" | "1080p";
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "4:3" | "3:4";
  duration?: string;
  seed?: number;
};

export function registerGenerateHappyhorseT2vVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_happyhorse_t2v_video", async (payload, ctx) => {
    const { vidAssetId, vidAssetDir, projectSlug, prompt, resolution, aspect_ratio, duration, seed } = payload as GenerateHappyhorseT2vVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const request = buildHappyHorseT2vPayload({ prompt, resolution, aspect_ratio, duration, seed });
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "happyhorse_t2v_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: { prompt, mode: "t2v" },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
