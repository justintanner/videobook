import { createElevenLabs } from "../usage-providers.js";
import type { Engine } from "videobook-engine";
import { findAudioFile } from "videobook-engine";
import type {
  ElevenLabsTranscript,
  ElevenLabsTranscriptWord,
  ElevenLabsSpeechToTextRequest,
  ElevenLabsSpeechToTextResponse,
} from "@apicity/elevenlabs";

import type {
  ArtifactStream,
  ImportTranscriptSegment,
  Transcript,
  TranscriptSegmentKind,
} from "videobook-engine";
import { requireApiKey } from "../api-key.js";
import { joinsWithoutSpace } from "../captions/script.js";
import { fileObjectHash, STALE_ANALYSIS_INPUTS } from "../analysis-sidecars.js";
import { audioObjectHash, hasCurrentElevenLabsTranscript, recordElevenLabsTranscript } from "../transcript-components.js";
import { joinUnspacedLetters } from "../transcript-words.js";
import { enqueueAssetTagging } from "./tag-asset.js";

const ELEVENLABS_TIMEOUT_MS = 5 * 60_000;

type TranscribeOptions = {
  tagAudioEvents: boolean;
  diarize: boolean;
  languageCode?: string;
};

function inferAudioMime(filename: string): string {
  const ext = filename.toLowerCase().split(".").pop() ?? "";
  switch (ext) {
    case "mp3":
      return "audio/mpeg";
    case "wav":
      return "audio/wav";
    case "m4a":
      return "audio/mp4";
    case "ogg":
      return "audio/ogg";
    case "weba":
      return "audio/webm";
    case "flac":
      return "audio/flac";
    case "mp4":
    case "mov":
      return "video/mp4";
    default:
      return "application/octet-stream";
  }
}

/**
 * Transcribe an asset's audio with ElevenLabs scribe_v2 and write the result
 * to `elevenlabs.json` in the asset directory. Lease-agnostic: the caller owns
 * the asset lease (the transcribe job's local lease, or the render job's render
 * lease when auto-transcribing). Throws on missing API key, unreadable audio,
 * or a failed write so the caller can surface the failure.
 */
export async function transcribeAssetToElevenLabsJson(
  engine: Engine,
  assetId: string,
  audioFilename: string,
  options: TranscribeOptions,
  run: { force?: boolean } = {},
): Promise<{ cached: boolean }> {
  const audioHash = await audioObjectHash(engine, assetId, audioFilename);
  if (!run.force && await hasCurrentElevenLabsTranscript(engine, { artifactId: assetId, audioHash, options })) {
    return { cached: true };
  }
  const response = await requestElevenLabsTranscript(
    engine,
    assetId,
    audioFilename,
    options,
  );
  if (await fileObjectHash(engine, assetId, audioFilename) !== audioHash) {
    throw new Error(STALE_ANALYSIS_INPUTS);
  }
  await writeElevenLabsTranscript(engine, assetId, response, options, audioHash);
  return { cached: false };
}

export async function requestElevenLabsTranscript(
  engine: Engine,
  assetId: string,
  audioFilename: string,
  options: TranscribeOptions,
): Promise<ElevenLabsSpeechToTextResponse> {
  const apiKey = requireApiKey("ELEVENLABS_API_KEY");

  const readResult = await engine.files.read(assetId, audioFilename);
  if (!readResult.ok) {
    throw new Error(`Failed to read audio for ${assetId}: ${readResult.error.message}`);
  }
  const audioBytes = new Uint8Array(readResult.value);
  const audioBlob = new Blob([audioBytes], { type: inferAudioMime(audioFilename) });

  const provider = createElevenLabs({ apiKey, timeout: ELEVENLABS_TIMEOUT_MS });
  const request: ElevenLabsSpeechToTextRequest = {
    model_id: "scribe_v2",
    file: audioBlob,
    tag_audio_events: options.tagAudioEvents,
    diarize: options.diarize,
    ...(options.languageCode ? { language_code: options.languageCode } : {}),
  };
  return provider.v1.speechToText(request);
}

export async function writeElevenLabsTranscript(
  engine: Engine,
  assetId: string,
  response: ElevenLabsSpeechToTextResponse,
  options: TranscribeOptions,
  audioHash: string,
): Promise<void> {
  const transcriptionStr = JSON.stringify(response, null, 2);
  const writeResult = await engine.files.write(assetId, "elevenlabs.json", transcriptionStr
  );
  if (!writeResult.ok) {
    throw new Error(`Failed to write transcription: ${writeResult.error.message}`);
  }

  await importElevenLabsTranscript(engine, assetId, response, options);
  await engine.history.recordOperation("transcribe", assetId, {
      ...(options.languageCode ? { language_code: options.languageCode } : {}),
    }
  );
  await recordElevenLabsTranscript(engine, { artifactId: assetId, audioHash, options });
}

type TimedTranscriptWord = ElevenLabsTranscriptWord & {
  channelIndex: number;
  spaceBefore: boolean;
};

type SegmentDraft = {
  kind: TranscriptSegmentKind;
  speaker?: string;
  channelIndex: number;
  start: number;
  end: number;
  words: TimedTranscriptWord[];
  text: string;
};

export async function importElevenLabsTranscript(
  engine: Engine,
  assetId: string,
  response: ElevenLabsSpeechToTextResponse,
  options: TranscribeOptions,
): Promise<Transcript> {
  const source = normalizedTranscripts(response);
  if (source.length === 0) {
    throw new Error("ElevenLabs returned an acknowledgement without transcript content");
  }
  const streams = engine.streams.list(assetId);
  if (!streams.ok) {
    throw new Error(`Failed to read media streams for ${assetId}: ${streams.error.message}`);
  }
  const stream = streams.value.find((candidate) => candidate.kind === "audio");
  if (!stream) throw new Error(`No audio stream is registered for ${assetId}`);
  const segments = transcriptSegments(source, stream);
  const language = options.languageCode
    ?? [...source].sort((left, right) =>
      right.language_probability - left.language_probability
    )[0]?.language_code
    ?? "und";
  const imported = await engine.transcripts.import({
    artifactId: assetId,
    streamId: stream.streamId,
    objectHash: stream.objectHash,
    language,
    provider: "elevenlabs",
    model: "scribe_v2",
    state: "current",
    segments,
  });
  if (!imported.ok) {
    throw new Error(`Failed to import transcript for ${assetId}: ${imported.error.message}`);
  }
  // Speech is the evidence audio tagging reads, and it can change what a video
  // is grouped by too.
  await enqueueAssetTagging(engine, assetId);
  return imported.value;
}

function normalizedTranscripts(
  response: ElevenLabsSpeechToTextResponse,
): ElevenLabsTranscript[] {
  if ("words" in response) return [response];
  if ("transcripts" in response) return response.transcripts;
  return [];
}

function channelWords(transcript: ElevenLabsTranscript): TimedTranscriptWord[] {
  const tokens = joinUnspacedLetters(transcript.words);
  return tokens.map((word, index) => ({
    ...word,
    channelIndex: transcript.channel_index,
    spaceBefore: index > 0 && tokens[index - 1].type === "spacing",
  }));
}

function transcriptSegments(
  transcripts: ElevenLabsTranscript[],
  stream: ArtifactStream,
): ImportTranscriptSegment[] {
  const timedWords = transcripts
    .flatMap(channelWords)
    .filter((word) =>
      word.type !== "spacing"
      && Number.isFinite(word.start)
      && Number.isFinite(word.end)
      && word.end > word.start
    )
    .sort((left, right) =>
      left.start - right.start
      || left.channelIndex - right.channelIndex
      || left.end - right.end
    );
  const drafts: SegmentDraft[] = [];
  for (const word of timedWords) {
    const kind = word.type === "audio_event"
      ? audioEventKind(word.text)
      : "speech";
    const speaker = speakerLabel(word);
    const previous = drafts.at(-1);
    const joinsPrevious = kind === "speech"
      && previous?.kind === "speech"
      && previous.speaker === speaker
      && previous.channelIndex === word.channelIndex
      && word.start - previous.end <= 1.25
      && word.end - previous.start <= 15;
    if (joinsPrevious && previous) {
      previous.end = Math.max(previous.end, word.end);
      previous.words.push(word);
      previous.text = joinedSpeech(previous.words);
      continue;
    }
    drafts.push({
      kind,
      ...(speaker ? { speaker } : {}),
      channelIndex: word.channelIndex,
      start: word.start,
      end: word.end,
      words: kind === "speech" ? [word] : [],
      text: kind === "speech" ? word.text.trim() : word.text.trim(),
    });
  }
  return drafts.map((draft, ordinal) => {
    const startTick = secondsToTick(draft.start, stream);
    const endTick = Math.max(
      startTick + 1,
      secondsToTick(draft.end, stream),
    );
    const confidenceValues = draft.words
      .map(wordConfidence)
      .filter((value): value is number => value !== undefined);
    const confidence = confidenceValues.length > 0
      ? confidenceValues.reduce((sum, value) => sum + value, 0)
        / confidenceValues.length
      : undefined;
    return {
      ordinal,
      range: {
        streamId: stream.streamId,
        objectHash: stream.objectHash,
        startTick,
        durationTicks: Math.min(stream.durationTicks, endTick) - startTick,
        timeBase: stream.timeBase,
      },
      ...(draft.speaker ? { speaker: draft.speaker } : {}),
      text: draft.text,
      ...(confidence !== undefined ? { confidence } : {}),
      kind: draft.kind,
      words: draft.words.map((word, wordOrdinal) => {
        const wordStartTick = secondsToTick(word.start, stream);
        const wordEndTick = Math.max(
          wordStartTick + 1,
          secondsToTick(word.end, stream),
        );
        const wordConfidenceValue = wordConfidence(word);
        return {
          ordinal: wordOrdinal,
          startTick: wordStartTick,
          durationTicks: Math.min(stream.durationTicks, wordEndTick) - wordStartTick,
          text: word.text.trim(),
          ...(wordConfidenceValue !== undefined
            ? { confidence: wordConfidenceValue }
            : {}),
          corrected: false,
        };
      }),
    };
  });
}

function secondsToTick(seconds: number, stream: ArtifactStream): number {
  const tick = Math.round(
    seconds * stream.timeBase.denominator / stream.timeBase.numerator,
  );
  return Math.max(0, Math.min(stream.durationTicks - 1, tick));
}

function speakerLabel(word: TimedTranscriptWord): string | undefined {
  const channel = word.channelIndex > 0 ? `channel-${word.channelIndex + 1}` : "";
  if (word.speaker_id && channel) return `${channel}:${word.speaker_id}`;
  return word.speaker_id ?? (channel || undefined);
}

function audioEventKind(text: string): TranscriptSegmentKind {
  const normalized = text.toLowerCase();
  if (normalized.includes("music") || normalized.includes("sing")) return "music";
  if (normalized.includes("silence") || normalized.includes("pause")) return "silence";
  return "sound";
}

function joinedSpeech(words: TimedTranscriptWord[]): string {
  let text = "";
  for (const word of words) {
    const next = word.text.trim();
    if (!next) continue;
    const glue = text.length > 0 && (word.spaceBefore || !joinsWithoutSpace(text, next));
    text += glue ? ` ${next}` : next;
  }
  return text.replace(/\s+([,.;:!?])/g, "$1");
}

function wordConfidence(word: TimedTranscriptWord): number | undefined {
  if (word.logprob === undefined || !Number.isFinite(word.logprob)) return undefined;
  return Math.max(0, Math.min(1, Math.exp(word.logprob)));
}

/**
 * Ensure an asset has ElevenLabs word-level timings (elevenlabs.json),
 * transcribing inline if it's missing. Idempotent — returns immediately when the
 * file already exists. Lease-agnostic: the caller owns the asset lease (a render
 * job's render lease, a plan job's analyze lease). Throws on missing audio, a
 * missing API key, or an API/write failure so the caller surfaces the cause.
 */
export async function ensureElevenLabsTranscript(
  engine: Engine,
  assetId: string,
): Promise<void> {
  if ((await engine.files.read(assetId, "elevenlabs.json")).ok) return;
  const manifest = await engine.files.manifest(assetId);
  if (!manifest.ok) throw new Error(`auto-transcribe failed: ${manifest.error.message}`);
  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) throw new Error(`auto-transcribe failed: ${artifact.error.message}`);
  const audioFile = findAudioFile(manifest.value.files, artifact.value.kind);
  if (!audioFile) throw new Error(`auto-transcribe failed: no audio file found in asset ${assetId}`);
  await transcribeAssetToElevenLabsJson(engine, assetId, audioFile.name, {
    tagAudioEvents: true,
    diarize: true,
  });
}
