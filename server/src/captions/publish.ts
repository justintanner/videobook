import { createHash } from "node:crypto";
import type { Engine, ImportTranscriptSegment, Transcript } from "videobook-engine";
import { queue } from "../queue.js";
import type { CaptionDocument, CaptionWord } from "./model.js";
import { ORIGINAL_CAPTION_LANGUAGE } from "./model.js";
import { joinCaptionWords } from "./script.js";

const CAPTION_TRANSCRIPT_PROVIDER = "videobook-captions";

function corrected(word: CaptionWord): boolean {
  return word.textCorrected || word.timingCorrected || word.hidden || word.analysed === null;
}

function documentHash(document: CaptionDocument): string {
  const words = document.words.filter((word) => !word.hidden).map((word) => [word.text, word.start, word.end]);
  return createHash("sha256").update(JSON.stringify(words)).digest("hex").slice(0, 24);
}

function latestTranscript(transcripts: readonly Transcript[]): Transcript | null {
  return [...transcripts].filter((transcript) => transcript.payloadAvailable).sort((left, right) => right.createdAt - left.createdAt)[0] ?? null;
}

function segmentsFor(document: CaptionDocument, transcript: Transcript, timeBase: { numerator: number; denominator: number }, durationTicks: number): ImportTranscriptSegment[] {
  const toTicks = (seconds: number) => Math.max(0, Math.min(durationTicks - 1, Math.round((seconds * timeBase.denominator) / timeBase.numerator)));
  const byId = new Map(document.words.map((word) => [word.id, word]));
  return document.phrases.flatMap((phrase) => {
    const words = phrase.wordIds.map((id) => byId.get(id)).filter((word): word is CaptionWord => Boolean(word && !word.hidden && word.text.trim()));
    if (words.length === 0) return [];
    const imported = words.map((word, ordinal) => {
      const startTick = toTicks(word.start);
      return { ordinal, startTick, durationTicks: Math.max(1, toTicks(word.end) - startTick), text: word.text, corrected: corrected(word) };
    });
    const first = imported[0];
    const last = imported[imported.length - 1];
    return [{
      range: {
        streamId: transcript.streamId,
        objectHash: transcript.objectHash,
        startTick: first.startTick,
        durationTicks: Math.max(1, last.startTick + last.durationTicks - first.startTick),
        timeBase,
      },
      text: joinCaptionWords(words.map((word) => word.text)),
      kind: "speech" as const,
      words: imported,
    }];
  }).map((segment, ordinal) => ({ ...segment, ordinal }));
}

export async function publishCaptionCorrections(engine: Engine, bookId: string, document: CaptionDocument): Promise<string | null> {
  if (document.language !== ORIGINAL_CAPTION_LANGUAGE || !document.words.some(corrected)) return null;
  const listed = await engine.transcripts.list(document.source.artifactId);
  if (!listed.ok) return null;
  const current = latestTranscript(listed.value);
  const model = `captions:${documentHash(document)}`;
  if (!current || (current.provider === CAPTION_TRANSCRIPT_PROVIDER && current.model === model)) return null;
  const stream = engine.streams.get(current.streamId);
  if (!stream.ok) return null;
  const segments = segmentsFor(document, current, stream.value.timeBase, stream.value.durationTicks);
  if (segments.length === 0) return null;
  const revised = await engine.transcripts.revise({ sourceTranscriptId: current.transcriptId, provider: CAPTION_TRANSCRIPT_PROVIDER, model, segments });
  if (!revised.ok) throw new Error(revised.error.message);
  if (process.env.NODE_ENV !== "test") {
    await queue.enqueue(`semantic-index-${document.source.artifactId}-captions-${Date.now()}`, {
      type: "semantic_index",
      assetId: document.source.artifactId,
      bookId,
    });
  }
  return revised.value.transcriptId;
}
