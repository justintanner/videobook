import type { Engine } from "videobook-engine";
import { queue, registerJobHandler } from "../queue.js";
import {
  DOWNSTREAM_LEASE_WAIT_MS,
  withLocalLease,
} from "./_lease.js";
import { transcribeAssetToElevenLabsJson } from "./_transcribe.js";
import {
  enqueueLazyAnalysisIfSlotted,
  enqueueLazyTimelineRender,
} from "../lazy-render.js";

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
      assetId,
      ctx,
      "transcribe",
      async () => {
        await transcribeAssetToElevenLabsJson(fs, assetId, audioFilename, {
          tagAudioEvents,
          diarize,
          ...(languageCode ? { languageCode } : {}),
        });
        return { success: true, provider: "elevenlabs" as const };
      },
      { waitForActiveMs: DOWNSTREAM_LEASE_WAIT_MS },
    );
    await queue.enqueue(`semantic-index-${assetId}-transcript-${Date.now()}`, {
      type: "semantic_index",
      assetId,
      bookId,
    } as unknown as Record<string, unknown>);
    try {
      await enqueueLazyAnalysisIfSlotted(fs, bookId, assetId);
    } catch (err) {
      void err;
    }
    try {
      await enqueueLazyTimelineRender(fs, bookId, assetId);
    } catch (err) {
      void err;
    }
    return result;
  });
}
