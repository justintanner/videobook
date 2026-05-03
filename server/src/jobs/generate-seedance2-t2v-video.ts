import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
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
  registerJobHandler("generate_seedance2_t2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      aspect_ratio, resolution, duration,
      generate_audio, return_last_frame, web_search,
    } = payload as GenerateSeedance2T2vVideoPayload;

    const apiKey = requireApiKey("KIE_API_KEY");

    const provider = kie({ apiKey, timeout: 60_000 });

    const request = buildSeedance2VideoPayload(
      { prompt, aspect_ratio, resolution, duration, generate_audio, return_last_frame, web_search },
      {},
    );
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "seedance2_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          prompt,
          mode: "t2v",
          ...(return_last_frame !== undefined ? { return_last_frame } : {}),
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
