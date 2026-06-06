import type { VideocityFs } from "vc-engine";
import { createOpenAi } from "@apicity/openai";
import { registerJobHandler } from "../queue.js";
import { getApiKey } from "../api-key.js";
import { withLocalLease } from "./_lease.js";
import { enqueueLazyTimelineRender } from "../lazy-render.js";

type TranscribeVideoAudioPayload = {
  type: "transcribe_video_audio";
  videoPath: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerTranscribeVideoAudioJob(fs: VideocityFs): void {
  registerJobHandler("transcribe_video_audio", async (payload, ctx) => {
    const { assetId, projectSlug } = payload as TranscribeVideoAudioPayload;

    const apiKey = getApiKey("OPENAI_API_KEY");
    if (!apiKey) return { success: false, reason: "OPENAI_API_KEY not set" };

    const result = await withLocalLease(fs, projectSlug, assetId, ctx, "transcribe", async () => {
      const readResult = await fs.readFile(assetId, "original.mp3", projectSlug);
      if (!readResult.ok) throw new Error(readResult.error.message);

      const file = new File([new Uint8Array(readResult.value)], "original.mp3", { type: "audio/mpeg" });
      const provider = createOpenAi({ apiKey, timeout: 120_000 });
      const result = await provider.post.v1.audio.transcriptions({
        file,
        model: "gpt-4o-mini-transcribe",
      });

      const jsonString = JSON.stringify(result, null, 2);
      await fs.writeFile(assetId, ".analysis.gpt4otrans.json", jsonString, projectSlug);

      return { success: true, text: result.text };
    });
    try {
      await enqueueLazyTimelineRender(fs, projectSlug, assetId);
    } catch (err) {
      void err;
    }
    return result;
  });
}
