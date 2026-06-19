import type { VideocityFs } from "videocity-engine";
import { registerJobHandler } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { transcribeAssetToElevenLabsJson } from "./_transcribe.js";
import { enqueueLazyTimelineRender } from "../lazy-render.js";

type TranscribePayload = {
  type: "transcribe";
  audioPath: string;
  audioFilename: string;
  tagAudioEvents: boolean;
  diarize: boolean;
  languageCode?: string;
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

export function registerTranscribeJob(fs: VideocityFs): void {
  registerJobHandler("transcribe", async (payload, ctx) => {
    const {
      audioFilename,
      tagAudioEvents,
      diarize,
      languageCode,
      assetId,
      projectSlug,
    } = payload as TranscribePayload;

    const result = await withLocalLease(
      fs,
      projectSlug,
      assetId,
      ctx,
      "transcribe",
      async () => {
        await transcribeAssetToElevenLabsJson(fs, projectSlug, assetId, audioFilename, {
          tagAudioEvents,
          diarize,
          ...(languageCode ? { languageCode } : {}),
        });
        return { success: true, provider: "elevenlabs" as const };
      },
    );
    try {
      await enqueueLazyTimelineRender(fs, projectSlug, assetId);
    } catch (err) {
      void err;
    }
    return result;
  });
}
