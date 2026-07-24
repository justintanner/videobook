import type { Engine } from "videobook-engine";
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
  bookId: string;
};

export function registerTranscribeJob(fs: Engine): void {
  registerJobHandler("transcribe", async (payload, ctx) => {
    const {
      audioFilename,
      tagAudioEvents,
      diarize,
      languageCode,
      assetId,
      bookId,
    } = payload as TranscribePayload;

    const result = await withLocalLease(
      fs,
      bookId,
      assetId,
      ctx,
      "transcribe",
      async () => {
        await transcribeAssetToElevenLabsJson(fs, bookId, assetId, audioFilename, {
          tagAudioEvents,
          diarize,
          ...(languageCode ? { languageCode } : {}),
        });
        return { success: true, provider: "elevenlabs" as const };
      },
    );
    try {
      await enqueueLazyTimelineRender(fs, bookId, assetId);
    } catch (err) {
      void err;
    }
    return result;
  });
}
