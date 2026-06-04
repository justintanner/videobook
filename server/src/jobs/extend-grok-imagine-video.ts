import type { VideocityFs } from "vc-engine";
import type { GrokImagineResolution, MediaGenerationRequest } from "@apicity/kie";
import { submitKieTask } from "./kie-paygate.js";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
type ExtendGrokImagineVideoPayload = {
  type: "extend_grok_imagine_video";
  sourceVideoId: string;
  sourceVideoFilename: string;
  vidAssetId: string;
  vidAssetDir: string;
  projectSlug: string;
  prompt: string;
  extend_at?: number;
  extend_times?: "6" | "10";
};

export function registerExtendGrokImagineVideoJob(fs: VideocityFs): void {
  registerJobHandler("extend_grok_imagine_video", async (payload, ctx) => {
    const {
      sourceVideoId, vidAssetId, vidAssetDir,
      projectSlug, prompt, extend_at, extend_times,
    } = payload as ExtendGrokImagineVideoPayload;

    requireApiKey("KIE_API_KEY");

    const kieTaskIdResult = await fs.readMetadata<{ taskId: string }>(sourceVideoId, "kie-task-id", projectSlug);
    if (!kieTaskIdResult.ok) {
      throw new Error(`No Kie taskId found for source video ${sourceVideoId}. The source video must have been generated via Kie.`);
    }
    const kieTaskId = kieTaskIdResult.value.taskId;

    // grok-imagine/extend inherits its resolution from the source video — the
    // kie input schema only carries task_id + extend_times. The cost estimator
    // (and the paygate OTP minted from this request) keys the rate off
    // (extend_times, resolution); without a resolution the lookup misses and
    // the estimate is rejected as unbounded. Surface the source video's
    // resolution as a top-level hint (mirrors veo3's top-level `duration` hint;
    // kie's createTask ignores unknown top-level fields), defaulting to the
    // grok-imagine default when the source predates resolution metadata.
    const sourcePayloadResult = await fs.readMetadata<{ input?: { resolution?: GrokImagineResolution } }>(
      sourceVideoId, "generation-payload", projectSlug,
    );
    const resolution: GrokImagineResolution =
      (sourcePayloadResult.ok && sourcePayloadResult.value?.input?.resolution) || "480p";

    const request: MediaGenerationRequest & { resolution: GrokImagineResolution } = {
      model: "grok-imagine/extend",
      resolution,
      input: {
        task_id: kieTaskId,
        prompt,
        extend_at: String(extend_at ?? 0),
        extend_times: extend_times ?? "6",
      },
    };

    const taskId = await submitKieTask(fs, ctx, {
      request,
      taskType: "grok_imagine_extend_video",
      assetId: vidAssetId,
      assetDir: vidAssetDir,
      projectSlug,
      meta: {
        sourceVideoId,
        prompt,
        ...(extend_at !== undefined ? { extend_at } : {}),
        ...(extend_times !== undefined ? { extend_times } : {}),
      },
    });

    return { success: true, taskId };
  });
}
