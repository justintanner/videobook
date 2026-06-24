import type { VideocityFs } from "videocity-engine";
import { registerJobHandler, type JobHandlerContext } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { withLocalLease } from "./_lease.js";
import { buildResponses } from "./describe-image.js";
import { enqueueLazyTimelineRender } from "../lazy-render.js";
import { parseSegments } from "../remotion/subtitles/segments.js";
import {
  iso1FromIso3,
  readLanguageCode,
  sidecarMatchesSource,
  translatedTranscriptFilename,
  translateTranscript,
} from "./_translate-transcript.js";

export type TranslateTranscriptPayload = {
  type: "translate_transcript";
  assetId: string;
  projectSlug: string;
  targetLanguage: string;
};

export type TranslateTranscriptResult = {
  success: true;
  targetLanguage: string;
  skipped?: "matches-source";
  cached?: true;
};

export async function runTranslateTranscript(
  fs: VideocityFs,
  payload: TranslateTranscriptPayload,
  ctx: JobHandlerContext,
): Promise<TranslateTranscriptResult> {
  const { assetId, projectSlug, targetLanguage } = payload;

  // Leased as "transcribe": the engine's AssetWorkKind union has no
  // translate kind, and sharing it serializes translation against
  // re-transcription of the same asset.
  const result = await withLocalLease(
    fs,
    projectSlug,
    assetId,
    ctx,
    "transcribe",
    async (): Promise<TranslateTranscriptResult> => {
      const readResult = await fs.readFile(assetId, "elevenlabs.json", projectSlug);
      if (!readResult.ok) {
        throw new Error(`No transcript for ${assetId}: ${readResult.error.message}. Transcribe the asset first.`);
      }
      const raw = JSON.parse(readResult.value.toString()) as unknown;

      if (iso1FromIso3(readLanguageCode(raw)) === targetLanguage) {
        return { success: true, targetLanguage, skipped: "matches-source" };
      }

      const sidecarFilename = translatedTranscriptFilename(targetLanguage);
      const existing = await fs.readFile(assetId, sidecarFilename, projectSlug);
      if (existing.ok) {
        const sourceSegments = parseSegments(raw as Parameters<typeof parseSegments>[0]);
        try {
          const sidecar = JSON.parse(existing.value.toString()) as unknown;
          if (sidecarMatchesSource(sidecar, sourceSegments)) {
            return { success: true, targetLanguage, cached: true };
          }
        } catch {
          // unreadable sidecar — re-translate below
        }
      }

      const responses = buildResponses(requireApiKey("KIE_API_KEY"));
      const sidecar = await translateTranscript(raw, targetLanguage, responses);

      const writeResult = await fs.writeFile(
        assetId,
        sidecarFilename,
        JSON.stringify(sidecar, null, 2),
        projectSlug,
      );
      if (!writeResult.ok) {
        throw new Error(`Failed to write ${sidecarFilename}: ${writeResult.error.message}`);
      }

      await fs.commitOperation("translate_transcript", assetId, { targetLanguage }, projectSlug);

      return { success: true, targetLanguage };
    },
  );
  try {
    await enqueueLazyTimelineRender(fs, projectSlug, assetId);
  } catch (err) {
    void err;
  }
  return result;
}

export function registerTranslateTranscriptJob(fs: VideocityFs): void {
  registerJobHandler("translate_transcript", (payload, ctx) =>
    runTranslateTranscript(fs, payload as TranslateTranscriptPayload, ctx));
}
