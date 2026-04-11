import type { ClipfirstFs } from "clipfirst-fs";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { writePendingTask } from "./pending-task.js";
import { buildSeedance2VideoPayload } from "../payload-builders.js";

type GenerateSeedance2T2vVideoPayload = {
  type: "generate_seedance2_t2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  aspect_ratio?: string;
  resolution?: "480p" | "720p";
  duration?: string;
  generate_audio?: boolean;
  return_last_frame?: boolean;
  web_search?: boolean;
};

export function registerGenerateSeedance2T2vVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_seedance2_t2v_video", async (payload) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      aspect_ratio, resolution, duration,
      generate_audio, return_last_frame, web_search,
    } = payload as GenerateSeedance2T2vVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const request = buildSeedance2VideoPayload(
      { prompt, aspect_ratio, resolution, duration, generate_audio, return_last_frame, web_search },
      {},
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await writePendingTask(fs, vidAssetId, projectSlug, {
      taskId,
      taskType: "seedance2_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      createdAt: new Date().toISOString(),
      meta: {
        prompt,
        mode: "t2v",
        ...(return_last_frame !== undefined ? { return_last_frame } : {}),
      },
    });

    return { success: true, taskId };
  });
}
