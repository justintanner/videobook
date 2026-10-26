import type { Engine } from "videobook-engine";
import { readAnalysisComponent, writeAnalysisComponent } from "../analysis-components.js";
import type { CaptionTranscript, CaptionVocal } from "./analysis.js";
import { CAPTION_VOCAL, readCaptionTranscript, vocalComponentKey, vocalValueSchema } from "./analysis.js";
import type { CaptionMediaSource } from "./source.js";
import {
  decodeVocalPcm,
  detectOnsets,
  envelopeSeries,
  HOP_SECONDS,
  rmsFrames,
  snapWordStarts,
  VOCAL_SAMPLE_RATE,
  wordEnergies,
} from "./vocal-dsp.js";

const ENVELOPE_HZ = 20;

export async function analyzeVocalTiming(source: CaptionMediaSource, transcript: CaptionTranscript, signal: AbortSignal): Promise<CaptionVocal> {
  const pcm = source.hasAudio ? await decodeVocalPcm(source.path, signal) : null;
  if (!pcm) {
    return { hopSeconds: HOP_SECONDS, envelopeHz: ENVELOPE_HZ, envelope: [], onsets: [], words: transcript.words.map((word) => ({ onset: word.start, energy: 0.5 })) };
  }
  const rms = rmsFrames(pcm, VOCAL_SAMPLE_RATE, HOP_SECONDS);
  const onsets = detectOnsets(rms, HOP_SECONDS);
  const starts = snapWordStarts(transcript.words, onsets);
  const energies = wordEnergies(transcript.words, rms, HOP_SECONDS);
  return {
    hopSeconds: HOP_SECONDS,
    envelopeHz: ENVELOPE_HZ,
    envelope: envelopeSeries(rms, ENVELOPE_HZ, HOP_SECONDS),
    onsets,
    words: transcript.words.map((_, index) => ({ onset: Math.max(0, starts[index]), energy: energies[index] })),
  };
}

export async function ensureCaptionVocalTiming(engine: Engine, source: CaptionMediaSource, signal: AbortSignal): Promise<boolean> {
  const transcript = await readCaptionTranscript(engine, source);
  if (!transcript || transcript.words.length === 0) return false;
  const key = vocalComponentKey(source.mediaHash, transcript.hash);
  if (readAnalysisComponent(engine, CAPTION_VOCAL, key, vocalValueSchema)) return true;
  writeAnalysisComponent(engine, {
    component: CAPTION_VOCAL.component,
    key,
    artifactId: source.artifactId,
    sourceHash: source.mediaHash,
    provenance: { analyzer: "caption-vocal-dsp", version: CAPTION_VOCAL.version, provider: null, model: null, createdAt: new Date().toISOString() },
    value: vocalValueSchema.parse(await analyzeVocalTiming(source, transcript, signal)),
  });
  return true;
}
