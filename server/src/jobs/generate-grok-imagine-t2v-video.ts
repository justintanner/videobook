import type { ClipfirstFs } from "clipfirst-engine";
import { kie, submitMediaJob } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { buildGrokImagineT2vVideoPayload } from "../payload-builders.js";

type GenerateGrokImagineT2vVideoPayload = {
  type: "generate_grok_imagine_t2v_video";
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  mode?: "fun" | "normal" | "spicy";
  duration?: number;
  resolution?: "480p" | "720p";
  aspect_ratio?: "16:9" | "9:16" | "1:1" | "2:3" | "3:2";
  nsfw_checker?: boolean;
};

export function registerGenerateGrokImagineT2vVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("generate_grok_imagine_t2v_video", async (payload, ctx) => {
    const {
      vidAssetId, vidAssetDir, projectSlug, prompt,
      mode, duration, resolution, aspect_ratio, nsfw_checker,
    } = payload as GenerateGrokImagineT2vVideoPayload;

    const apiKey = process.env.KIE_API_KEY;
    if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

    const provider = kie({ apiKey, timeout: 60_000 });

    const request = buildGrokImagineT2vVideoPayload({
      prompt, mode, duration, resolution, aspect_ratio, nsfw_checker,
    });
    await fs.writeMetadata(vidAssetId, "generation-payload", request, projectSlug);
    const taskId = await submitMediaJob(provider, request);
    await fs.writeMetadata(vidAssetId, "kie-task-id", { taskId }, projectSlug);
    {
      const _ptResult = await fs.pendingTasks.write(projectSlug, {
        taskId,
        taskType: "grok_imagine_t2v_video",
        assetId: vidAssetId,
        assetDir: vidAssetDir,
        meta: {
          prompt,
          ...(mode !== undefined ? { mode } : {}),
          ...(duration !== undefined ? { duration } : {}),
          ...(resolution !== undefined ? { resolution } : {}),
        },
    }, ctx.getOwnerId());
      if (!_ptResult.ok) throw new Error(`Failed to write pending-task for ${vidAssetId}: ${_ptResult.error.message}`);
      if (_ptResult.value === null) throw new Error(`Lost local lease while writing pending-task`);
    }
    ctx.setLease({ kind: "task", taskId });

    return { success: true, taskId };
  });
}
