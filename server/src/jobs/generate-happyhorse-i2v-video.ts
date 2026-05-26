import type { ClipfirstFs } from "vc-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { uploadAssetToKie } from "./_kie-upload.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { buildHappyHorseI2vPayload } from "../payload-builders.js";

type RefInput = { assetId: string; filename: string };

type GenerateHappyhorseI2vVideoPayload = {
  type: "generate_happyhorse_i2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  firstFrame: RefInput;
  sourceImageIds: string[];
  prompt?: string;
  resolution?: "720p" | "1080p";
  duration?: string;
  seed?: number;
};

export function registerGenerateHappyhorseI2vVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_happyhorse_i2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug,
      firstFrame, sourceImageIds,
      prompt, resolution, duration, seed,
    } = payload as GenerateHappyhorseI2vVideoPayload;

    const apiKey = requireApiKey("KIE_API_KEY");

    const provider = kie({ apiKey, timeout: 60_000 });

    const imageUrl = await uploadAssetToKie(fs, firstFrame.assetId, firstFrame.filename, projectSlug);

    const request = buildHappyHorseI2vPayload({ prompt, resolution, duration, seed }, imageUrl);
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "happyhorse_i2v_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: { mode: "i2v", sourceImageIds, ...(prompt !== undefined ? { prompt } : {}) },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
