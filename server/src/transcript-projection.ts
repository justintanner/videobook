import type { ArtifactKind, ArtifactManifestFile, Engine } from "videobook-engine";
import { assessDialogQuality } from "./dialog-quality.js";

/** Artifact kinds whose media can carry speech worth transcribing. */
export function hasSpokenAudio(kind: ArtifactKind): boolean {
  return kind === "video" || kind === "audio" || kind === "final";
}

/** Word-level ElevenLabs speech-to-text output written by the transcribe job. */
export const TIMED_TRANSCRIPT_FILE = "elevenlabs.json";
/** Plain-text transcription sidecar written during ingest. */
export const PLAIN_TRANSCRIPT_FILE = ".analysis.gpt4otrans.json";

type TranscriptWord = {
  text: string;
  start: number;
  end: number;
  speakerId: string | null;
};

type AssetTranscript =
  | {
    kind: "timed";
    languageCode: string | null;
    text: string;
    words: TranscriptWord[];
  }
  | { kind: "plain"; text: string }
  | { kind: "silence" }
  | { kind: "missing" };

/** Compact transcript shipped inside asset payloads — no per-word cues. */
type AssetTranscriptSummary = {
  kind: "timed" | "plain" | "silence";
  language_code: string | null;
  text: string;
  word_count: number;
};

type RawTimedWord = {
  text: string;
  start: number;
  end: number;
  type?: string;
  speaker_id?: string | null;
};

type RawTranscript = {
  language_code?: string;
  text?: string;
  words?: unknown[];
};

type RawMultichannelTranscript = {
  transcripts?: RawTranscript[];
};

function parseJson(value: Buffer | string): unknown {
  try {
    return JSON.parse(value.toString()) as unknown;
  } catch {
    return null;
  }
}

function firstChannelTranscript(raw: unknown): RawTranscript | null {
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj.words !== "undefined") return obj as RawTranscript;
  const channels = (obj as RawMultichannelTranscript).transcripts;
  if (Array.isArray(channels) && channels.length > 0) return channels[0];
  return null;
}

function isTimedWord(value: unknown): value is RawTimedWord {
  if (typeof value !== "object" || value === null) return false;
  const word = value as Record<string, unknown>;
  return typeof word.text === "string"
    && typeof word.start === "number"
    && typeof word.end === "number";
}

/** Audio events ("[laughter]") and spacing entries are not spoken words. */
function isSpeech(word: RawTimedWord): boolean {
  return word.type !== "audio_event" && word.type !== "spacing";
}

export function timedTranscriptFrom(raw: unknown): AssetTranscript | null {
  const transcript = firstChannelTranscript(raw);
  if (!transcript || !Array.isArray(transcript.words)) return null;
  const speech = transcript.words.filter(isTimedWord).filter(isSpeech);
  if (speech.length === 0) return { kind: "silence" };
  return {
    kind: "timed",
    languageCode: transcript.language_code ?? null,
    text: transcript.text ?? speech.map((word) => word.text).join(""),
    words: speech.map((word) => ({
      text: word.text,
      start: word.start,
      end: word.end,
      speakerId: word.speaker_id ?? null,
    })),
  };
}

function plainTranscriptFrom(raw: unknown): AssetTranscript | null {
  if (typeof raw !== "object" || raw === null) return null;
  const quality = assessDialogQuality(raw as { text?: string });
  if (!quality.hasDialog && (quality.reason === "empty" || quality.reason === "noise_only")) {
    return { kind: "silence" };
  }
  return { kind: "plain", text: quality.text };
}

type AssetTranscriptWordSummary = {
  text: string;
  start: number;
  end: number;
};

type AssetTranscriptSourceSummary = AssetTranscriptSummary & {
  words?: AssetTranscriptWordSummary[];
};

/** Compact two-source transcript shipped inside asset payloads — no raw sidecar JSON. */
export type AssetTranscriptSources = {
  elevenlabs: AssetTranscriptSourceSummary | null;
  plain: AssetTranscriptSourceSummary | null;
};

type TranscriptSidecarKind = "elevenlabs" | "plain";

type TranscriptSidecarText = {
  source: TranscriptSidecarKind;
  file: string;
  text: string;
};

type AssetTranscriptRead = {
  transcript: AssetTranscript;
  source: "timed" | "plain" | "none";
};

function sidecarFile(source: TranscriptSidecarKind): string {
  return source === "elevenlabs" ? TIMED_TRANSCRIPT_FILE : PLAIN_TRANSCRIPT_FILE;
}

async function readTimedTranscript(
  engine: Engine,
  assetId: string,
): Promise<AssetTranscript | null> {
  const timedRead = await engine.files.read(assetId, TIMED_TRANSCRIPT_FILE);
  if (!timedRead.ok) return null;
  return timedTranscriptFrom(parseJson(timedRead.value));
}

async function readPlainTranscript(
  engine: Engine,
  assetId: string,
): Promise<AssetTranscript | null> {
  const plainRead = await engine.files.read(assetId, PLAIN_TRANSCRIPT_FILE);
  if (!plainRead.ok) return null;
  return plainTranscriptFrom(parseJson(plainRead.value));
}

async function readAssetTranscriptWithSource(
  engine: Engine,
  assetId: string,
): Promise<AssetTranscriptRead> {
  const timed = await readTimedTranscript(engine, assetId);
  if (timed) return { transcript: timed, source: "timed" };
  const plain = await readPlainTranscript(engine, assetId);
  if (plain) return { transcript: plain, source: "plain" };
  return { transcript: { kind: "missing" }, source: "none" };
}

/**
 * Resolve the best transcript for an artifact: word-timed ElevenLabs cues when
 * present, otherwise the plain ingest transcription.
 */
export async function readAssetTranscript(
  engine: Engine,
  assetId: string,
): Promise<AssetTranscript> {
  return (await readAssetTranscriptWithSource(engine, assetId)).transcript;
}

function countWords(text: string): number {
  const stripped = text.replace(/\[[^\]]*\]/g, "").trim();
  return stripped.length === 0 ? 0 : stripped.split(/\s+/).length;
}

function transcriptSummary(
  transcript: AssetTranscript,
): AssetTranscriptSummary | null {
  if (transcript.kind === "missing") return null;
  if (transcript.kind === "silence") {
    return { kind: "silence", language_code: null, text: "", word_count: 0 };
  }
  if (transcript.kind === "plain") {
    return {
      kind: "plain",
      language_code: null,
      text: transcript.text,
      word_count: countWords(transcript.text),
    };
  }
  return {
    kind: "timed",
    language_code: transcript.languageCode,
    text: transcript.text,
    word_count: transcript.words.length,
  };
}

function transcriptSourceSummary(
  transcript: AssetTranscript,
): AssetTranscriptSourceSummary | null {
  const summary = transcriptSummary(transcript);
  if (!summary) return null;
  if (transcript.kind !== "timed") return summary;
  return {
    ...summary,
    words: transcript.words.map((word) => ({
      text: word.text,
      start: word.start,
      end: word.end,
    })),
  };
}

/** Word-timed transcripts are large; asset listings re-read them constantly.
 *  Their content-addressed hash makes an in-process memo safe and exact. */
const SUMMARY_CACHE_LIMIT = 512;
const summaryByObjectHash = new Map<string, AssetTranscriptSourceSummary>();

function rememberSummary(
  objectHash: string,
  summary: AssetTranscriptSourceSummary,
): void {
  summaryByObjectHash.delete(objectHash);
  summaryByObjectHash.set(objectHash, summary);
  while (summaryByObjectHash.size > SUMMARY_CACHE_LIMIT) {
    const oldest = summaryByObjectHash.keys().next().value;
    if (typeof oldest !== "string") return;
    summaryByObjectHash.delete(oldest);
  }
}

async function readTimedSource(
  engine: Engine,
  assetId: string,
  timedHash: string | null,
): Promise<AssetTranscriptSourceSummary | null> {
  if (timedHash) {
    const cached = summaryByObjectHash.get(timedHash);
    if (cached) return cached;
  }
  const timed = await readTimedTranscript(engine, assetId);
  if (!timed) return null;
  const summary = transcriptSourceSummary(timed);
  if (timedHash && summary) rememberSummary(timedHash, summary);
  return summary;
}

/** Both transcript sidecars, independently, or null when neither exists.
 *  Pass the artifact's manifest files to skip missing sidecars and reuse the
 *  cached projection of an unchanged word-timed transcript. */
export async function readAssetTranscriptSources(
  engine: Engine,
  assetId: string,
  files?: readonly ArtifactManifestFile[],
): Promise<AssetTranscriptSources | null> {
  const timedFile = files?.find((file) => file.name === TIMED_TRANSCRIPT_FILE);
  const plainFile = files?.find((file) => file.name === PLAIN_TRANSCRIPT_FILE);
  if (files && !timedFile && !plainFile) return null;
  const elevenlabs = !files || timedFile
    ? await readTimedSource(engine, assetId, timedFile?.objectHash ?? null)
    : null;
  const plain = !files || plainFile
    ? transcriptSourceSummary(
      await readPlainTranscript(engine, assetId) ?? { kind: "missing" },
    )
    : null;
  if (!elevenlabs && !plain) return null;
  return { elevenlabs, plain };
}

export async function readTranscriptSidecarText(
  engine: Engine,
  assetId: string,
  source?: TranscriptSidecarKind,
): Promise<TranscriptSidecarText | null> {
  const order: TranscriptSidecarKind[] = source
    ? [source]
    : ["elevenlabs", "plain"];
  for (const kind of order) {
    const file = sidecarFile(kind);
    const read = await engine.files.read(assetId, file);
    if (!read.ok) continue;
    return { source: kind, file, text: read.value.toString() };
  }
  return null;
}
