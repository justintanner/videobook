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
  force?: boolean;
};

export function registerTranscribeJob(engine: Engine): void {
  registerJobHandler("transcribe", async (payload, ctx) => {
    const {
      audioFilename,
      tagAudioEvents,
      diarize,
      languageCode,
      assetId,
      bookId,
      force,
    } = payload as TranscribePayload;

    const result = await withLocalLease(
      engine,
      assetId,
      ctx,
      "transcribe",
      async () => {
        const { cached } = await transcribeAssetToElevenLabsJson(engine, assetId, audioFilename, {
          tagAudioEvents,
          diarize,
          ...(languageCode ? { languageCode } : {}),
        }, { force: force === true });
        return { success: true, provider: "elevenlabs" as const, cached };
      },
      { waitForActiveMs: DOWNSTREAM_LEASE_WAIT_MS },
    );
    if (!result.cached) {
      await queue.enqueue(`semantic-index-${assetId}-transcript-${Date.now()}`, {
        type: "semantic_index",
        assetId,
        bookId,
      } as unknown as Record<string, unknown>);
    }
    try {
      await enqueueLazyAnalysisIfSlotted(engine, bookId, assetId);
    } catch (err) {
      void err;
    }
    try {
      await enqueueLazyTimelineRender(engine, bookId, assetId);
    } catch (err) {
      void err;
    }
    return result;
  });
}
