import type { Engine } from "videobook-engine";
import { z } from "zod";
import { findVideoFile } from "videobook-engine";
import { joinCaptionWords } from "../captions/script.js";
import { joinUnspacedLetters } from "../transcript-words.js";
const MAX_FRAMES = 15;
const SILENCE_MARKER_THRESHOLD_S = 0.5;
export const DEAD_AIR_THRESHOLD_S = 1.5;
export const TRIM_BUDGET_FRACTION = 0.4;
const CANDIDATE_TOLERANCE_S = 0.3;

export type ElevenLabsWord = {
  text: string;
  start: number;
  end: number;
  type: "word" | "spacing";
  speaker_id?: string;
};

export type ElevenLabs = {
  text: string;
  language_code?: string;
  words: ElevenLabsWord[];
};

type Gpt4oTrans = {
  text: string;
  language?: string;
};

type OriginalMeta = {
  width?: number;
  height?: number;
  duration?: number;
  hasAudio?: boolean;
};

type PriorAnalysis = {
  summary?: string;
  mood?: string;
  scenes?: Array<{ timestamp?: number; description?: string }>;
};

type TranscriptResult =
  | { source: "elevenlabs"; words: ElevenLabsWord[]; text: string }
  | { source: "gpt4otrans"; text: string }
  | { source: "none" };

type SilenceCandidate = { start: number; end: number; duration: number };

export const TrimSchema = z.object({
  cut_start: z.number().min(0),
  cut_end: z.number().min(0),
  reason: z.string(),
  severity: z.enum(["low", "med", "high"]),
});

export const SfxSchema = z.object({
  timestamp: z.number().min(0),
  type: z.string(),
  description: z.string(),
});

export type Trim = z.infer<typeof TrimSchema>;
export type Sfx = z.infer<typeof SfxSchema>;

function decodeBuffer(buf: Buffer | string | Uint8Array): string {
  if (typeof buf === "string") return buf;
  return new TextDecoder().decode(buf);
}

export function sampleFrames(frames: string[]): string[] {
  if (frames.length <= MAX_FRAMES) return frames;
  const step = (frames.length - 1) / (MAX_FRAMES - 1);
  return Array.from({ length: MAX_FRAMES }, (_, i) =>
    frames[Math.round(i * step)]
  );
}

export function extractSilenceCandidates(
  words: ElevenLabsWord[],
  minDurationS: number,
): SilenceCandidate[] {
  const wordEntries = joinUnspacedLetters(words).filter((w) => w.type === "word");
  const out: SilenceCandidate[] = [];
  for (let i = 1; i < wordEntries.length; i++) {
    const prev = wordEntries[i - 1];
    const curr = wordEntries[i];
    const gap = curr.start - prev.end;
    if (gap >= minDurationS) {
      out.push({ start: prev.end, end: curr.start, duration: gap });
    }
  }
  return out;
}

function formatCandidatesBlock(candidates: SilenceCandidate[]): string {
  if (candidates.length === 0) return "Silence candidates: none (transcript has no gaps >= 1.5s)";
  const lines = candidates.map(
    (c, i) =>
      `  ${i + 1}. ${c.start.toFixed(2)}s -> ${c.end.toFixed(2)}s (duration ${c.duration.toFixed(2)}s)`,
  );
  return `Silence candidates (the only valid sources for severity "high" trims):\n${lines.join("\n")}`;
}

function condenseElevenLabsWords(words: ElevenLabsWord[]): string {
  const wordEntries = words.filter((w) => w.type === "word");
  if (wordEntries.length === 0) return "(no words)";

  const lines: string[] = [];
  let currentSpeaker: string | undefined = undefined;
  let currentTurn: string[] = [];
  let turnStart = 0;
  let prevEnd: number | null = null;

  const flush = () => {
    if (currentTurn.length === 0) return;
    const spk = currentSpeaker ?? "?";
    lines.push(`[t=${turnStart.toFixed(2)} spk=${spk}] ${joinCaptionWords(currentTurn)}`);
    currentTurn = [];
  };

  for (const w of wordEntries) {
    if (prevEnd !== null) {
      const gap = w.start - prevEnd;
      if (gap > SILENCE_MARKER_THRESHOLD_S) {
        flush();
        lines.push(`[silence=${gap.toFixed(2)}s]`);
        currentSpeaker = undefined;
      }
    }
    if (w.speaker_id !== currentSpeaker) {
      flush();
      currentSpeaker = w.speaker_id;
      turnStart = w.start;
    }
    if (currentTurn.length === 0) turnStart = w.start;
    currentTurn.push(w.text.trim());
    prevEnd = w.end;
  }
  flush();
  return lines.join("\n");
}

async function loadTranscript(
  engine: Engine,
  assetId: string,
): Promise<TranscriptResult | null> {
  const elevenRead = await engine.files.read(assetId, "elevenlabs.json");
  if (elevenRead.ok) {
    try {
      const parsed = JSON.parse(decodeBuffer(elevenRead.value)) as ElevenLabs;
      if (Array.isArray(parsed.words) && parsed.words.length > 0) {
        return { source: "elevenlabs", words: parsed.words, text: parsed.text ?? "" };
      }
    } catch {
      // fall through to gpt4otrans
    }
  }
  const gptRead = await engine.files.read(assetId, ".analysis.gpt4otrans.json");
  if (gptRead.ok) {
    try {
      const parsed = JSON.parse(decodeBuffer(gptRead.value)) as Gpt4oTrans;
      if (parsed.text) {
        return { source: "gpt4otrans", text: parsed.text };
      }
    } catch {
      // fall through
    }
  }
  return null;
}

async function loadPriorAnalysis(
  engine: Engine,
  assetId: string,
): Promise<PriorAnalysis | null> {
  const read = await engine.files.read(assetId, ".original.analysis.json");
  if (!read.ok) return null;
  try {
    return JSON.parse(decodeBuffer(read.value)) as PriorAnalysis;
  } catch {
    return null;
  }
}

function isWithinCandidate(
  cutStart: number,
  cutEnd: number,
  candidates: SilenceCandidate[],
): boolean {
  return candidates.some(
    (c) =>
      cutStart >= c.start - CANDIDATE_TOLERANCE_S
      && cutEnd <= c.end + CANDIDATE_TOLERANCE_S,
  );
}

export function filterValidTrims(
  trims: Trim[],
  candidates: SilenceCandidate[],
  trimBudgetS: number,
  evidence: { duration: number | null; transcriptSource: TranscriptResult["source"] },
): { kept: Trim[]; dropped: Array<{ trim: Trim; reason: string }> } {
  const dropped: Array<{ trim: Trim; reason: string }> = [];
  const sorted = [...trims].sort((a, b) => a.cut_start - b.cut_start);
  const kept: Trim[] = [];
  let totalDuration = 0;
  let lastEnd = -Infinity;

  for (const t of sorted) {
    if (evidence.duration !== null && t.cut_end > evidence.duration) {
      dropped.push({ trim: t, reason: "cut_end exceeds video duration" });
      continue;
    }
    if (t.cut_end <= t.cut_start) {
      dropped.push({ trim: t, reason: "cut_end <= cut_start" });
      continue;
    }
    if (t.cut_start < lastEnd) {
      dropped.push({ trim: t, reason: `overlaps previous kept trim ending at ${lastEnd.toFixed(2)}s` });
      continue;
    }
    if (t.severity === "high" && !isWithinCandidate(t.cut_start, t.cut_end, candidates)) {
      dropped.push({
        trim: t,
        reason: `severity:"high" trim ${t.cut_start.toFixed(2)}->${t.cut_end.toFixed(2)} is not contained in any silence candidate`,
      });
      continue;
    }
    if (t.severity === "med" && evidence.transcriptSource !== "elevenlabs") {
      dropped.push({ trim: t, reason: "filler trims require a word-timed transcript" });
      continue;
    }
    if (t.severity === "med" && t.cut_end - t.cut_start > 1.5) {
      dropped.push({
        trim: t,
        reason: `severity:"med" trim is ${(t.cut_end - t.cut_start).toFixed(2)}s — fillers must be < 1.5s`,
      });
      continue;
    }
    const dur = t.cut_end - t.cut_start;
    if (totalDuration + dur > trimBudgetS) {
      dropped.push({
        trim: t,
        reason: `trim budget exceeded (${(totalDuration + dur).toFixed(2)}s > ${trimBudgetS.toFixed(2)}s)`,
      });
      continue;
    }
    kept.push(t);
    totalDuration += dur;
    lastEnd = t.cut_end;
  }
  return { kept, dropped };
}

function metaLine(meta: OriginalMeta | null): string | null {
  if (!meta) return null;
  const dims = meta.width && meta.height ? `${meta.width}x${meta.height}` : "unknown size";
  const dur = typeof meta.duration === "number" ? `${meta.duration.toFixed(1)}s` : "unknown duration";
  return `Video metadata: ${dims}, duration ${dur}, hasAudio=${meta.hasAudio ?? "unknown"}`;
}

function priorLine(prior: PriorAnalysis | null): string | null {
  if (!prior) return null;
  const scenes = (prior.scenes ?? [])
    .map((s) => `t=${(s.timestamp ?? 0).toFixed(1)}s: ${s.description ?? ""}`)
    .join("; ");
  return `Prior analysis — summary: ${prior.summary ?? "n/a"}; mood: ${prior.mood ?? "n/a"}; scenes: ${scenes || "n/a"}`;
}

function transcriptLine(transcript: TranscriptResult): string {
  if (transcript.source === "none") {
    return "Transcript: unavailable. Assess visual pacing only; do not infer speech, silence, filler words, or audio events from missing transcription.";
  }
  if (transcript.source === "elevenlabs") {
    return `Transcript (word-level, with silence markers):\n${condenseElevenLabsWords(transcript.words)}`;
  }
  return `Transcript (no word timings):\n${transcript.text}`;
}

export function buildCutsContext(
  meta: OriginalMeta | null,
  prior: PriorAnalysis | null,
  transcript: TranscriptResult,
  frameCount: number,
  candidates: SilenceCandidate[],
  trimBudgetS: number,
  instructions?: string,
): string {
  const parts: string[] = [];
  if (instructions?.trim()) parts.push(`Editing request: ${instructions.trim()}`);
  const m = metaLine(meta);
  if (m) parts.push(m);
  parts.push(`Trim budget: total trim duration must be <= ${trimBudgetS.toFixed(1)}s.`);
  if (transcript.source === "elevenlabs") {
    parts.push(formatCandidatesBlock(candidates));
  } else if (transcript.source === "gpt4otrans") {
    parts.push("Silence candidates: none (transcript has no word timings; only visually supported severity \"low\" trims are allowed).");
  } else {
    parts.push("Silence candidates: none (no transcript; only visually supported severity \"low\" trims are allowed).");
  }
  const p = priorLine(prior);
  if (p) parts.push(p);
  parts.push(transcriptLine(transcript));
  parts.push(`${frameCount} timestamped frames follow.`);
  return parts.join("\n\n");
}

export function buildSfxContext(
  meta: OriginalMeta | null,
  prior: PriorAnalysis | null,
  transcript: TranscriptResult,
  frameCount: number,
): string {
  const parts: string[] = [];
  const m = metaLine(meta);
  if (m) parts.push(m);
  const p = priorLine(prior);
  if (p) parts.push(p);
  parts.push(transcriptLine(transcript));
  parts.push(`${frameCount} frames at low detail follow.`);
  return parts.join("\n\n");
}

type AssetForAnalysis = {
  manifest: { path: string; files: Array<{ name: string }>; directories?: Record<string, string[]> };
  frameNames: string[];
  transcript: TranscriptResult;
  meta: OriginalMeta | null;
  prior: PriorAnalysis | null;
};

type AssetForAnalysisError =
  | { kind: "manifest"; message: string }
  | { kind: "no-video"; message: string }
  | { kind: "no-frames"; message: string }
  | { kind: "no-transcript"; message: string };

export async function loadAssetForAnalysis(
  engine: Engine,
  assetId: string,
  options: { requireTranscript?: boolean } = {},
): Promise<{ ok: true; value: AssetForAnalysis } | { ok: false; error: AssetForAnalysisError }> {
  const manifestResult = await engine.files.manifest(assetId);
  if (!manifestResult.ok) {
    return { ok: false, error: { kind: "manifest", message: manifestResult.error.message } };
  }
  const manifest = manifestResult.value;

  const videoFile = findVideoFile(manifest.files);
  if (!videoFile) {
    return { ok: false, error: { kind: "no-video", message: "No video file found. Wait for the selected video's generation or upload to finish." } };
  }

  const frameNames = (manifest.directories?.["original_frames"] ?? [])
    .filter((f) => f.endsWith(".jpg"))
    .sort((a, b) => parseFloat(a) - parseFloat(b));
  if (frameNames.length === 0) {
    return {
      ok: false,
      error: { kind: "no-frames", message: "The selected video has no frames yet. Run /process-video for its notebook cell first." },
    };
  }

  const transcript = await loadTranscript(engine, assetId);
  if (!transcript && options.requireTranscript !== false) {
    return {
      ok: false,
      error: { kind: "no-transcript", message: "No transcript found. Run /transcribe for the selected video's notebook cell first." },
    };
  }

  const metaResult = await engine.metadata.artifacts.read<OriginalMeta>(assetId, "original");
  const meta = metaResult.ok ? metaResult.value : null;
  const prior = await loadPriorAnalysis(engine, assetId);

  return {
    ok: true,
    value: {
      manifest,
      frameNames,
      transcript: transcript ?? { source: "none" },
      meta,
      prior,
    },
  };
}
