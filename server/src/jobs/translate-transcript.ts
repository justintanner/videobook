import type { Engine } from "videobook-engine";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";
import { withLocalLease } from "./_lease.js";
import { enqueueLazyTimelineRender } from "../lazy-render.js";
import { readArtifactJson } from "../analysis-sidecars.js";
import { ensureTranscriptTranslation } from "../transcript-translation.js";
import { TIMED_TRANSCRIPT_FILE } from "../transcript-projection.js";
import { iso1FromIso3, readLanguageCode } from "./_translate-transcript.js";

type TranslateTranscriptPayload = {
  type: "translate_transcript";
  assetId: string;
  bookId: string;
  targetLanguage: string;
  force?: boolean;
};

type TranslateTranscriptResult = {
  success: true;
  targetLanguage: string;
  skipped?: "matches-source";
  cached?: true;
};

export async function runTranslateTranscript(
  engine: Engine,
  payload: TranslateTranscriptPayload,
  ctx: JobHandlerContext,
): Promise<TranslateTranscriptResult> {
  const { assetId, bookId, targetLanguage } = payload;

  // Leased as "transcribe": the engine's ArtifactWorkKind union has no
  // translate kind, and sharing it serializes translation against
  // re-transcription of the same asset.
  const result = await withLocalLease(
    engine,
    assetId,
    ctx,
    "transcribe",
    async (): Promise<TranslateTranscriptResult> => {
      const raw = await readArtifactJson(engine, assetId, TIMED_TRANSCRIPT_FILE);
      if (!raw) throw new Error(`No transcript for ${assetId}. Transcribe the asset first.`);
      if (iso1FromIso3(readLanguageCode(raw)) === targetLanguage) {
        return { success: true, targetLanguage, skipped: "matches-source" };
      }
      const status = await ensureTranscriptTranslation(engine, assetId, targetLanguage, { force: payload.force === true, signal: ctx.signal });
      if (status === "cached") return { success: true, targetLanguage, cached: true };
      await engine.history.recordOperation("translate_transcript", assetId, { targetLanguage });
      return { success: true, targetLanguage };
    },
  );
  try {
    await enqueueLazyTimelineRender(engine, bookId, assetId);
  } catch (err) {
    void err;
  }
  return result;
}

export function registerTranslateTranscriptJob(engine: Engine): void {
  registerJobHandler("translate_transcript", (payload, ctx) =>
    runTranslateTranscript(engine, payload as TranslateTranscriptPayload, ctx));
}
