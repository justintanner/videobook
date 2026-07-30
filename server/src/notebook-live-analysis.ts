import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOpenAi,
  type OpenAiResponseRequest,
  type OpenAiResponseResponse,
  type OpenAiResponseInputContent,
} from "@apicity/openai";
import { z } from "zod";
import {
  findAudioFile,
  type Engine,
  type Transcript,
} from "videobook-engine";
import { getApiKey } from "./api-key.js";
import { runFfmpeg } from "./ffmpeg.js";
import { materializeArtifactFile } from "./notebook-media-ops.js";
import { MAX_SHOT_SECONDS } from "./notebook-shots.js";
import {
  ANALYSIS_REASONING_EFFORT,
  INTELLIGENCE_MODEL,
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
  type ResponsesFn,
} from "./openai-intelligence.js";
import {
  deriveCameraCandidates,
  detectSceneSamples,
  refineCameraCandidate,
  type CameraCandidate,
} from "./scene-detect.js";

const MAX_ANALYSIS_FRAMES = 15;
const CAMERA_BATCH_SIZE = 6;
const CAMERA_BATCH_CONCURRENCY = 2;
const CAMERA_ACCEPT_CONFIDENCE = 0.75;
const CAMERA_RECHECK_CONFIDENCE = 0.6;
const AUDIO_TARGET_WINDOW_SECONDS = 3;
const AUDIO_BOUNDARY_MIN_SPACING_SECONDS = 4;
const CAMERA_FRAME_OFFSETS = [-0.5, -0.1, 0.1, 0.5] as const;

export type AnalysisBoundaryKind =
  | "source_start"
  | "camera_cut"
  | "audio_transition"
  | "duration_fallback"
  | "source_end";

export type AnalysisBoundary = {
  id: string;
  timestampSeconds: number;
  kind: AnalysisBoundaryKind;
  confidence: number;
  evidenceIds: string[];
};

export type VisualCandidateRecord = {
  id: string;
  timestampSeconds: number;
  score: number;
  frameTimestamps: number[];
};

export type VisualDecisionRecord = {
  candidateId: string;
  accepted: boolean;
  cameraSwitch: boolean;
  transitionType: "hard_cut" | "dissolve" | "false_positive";
  confidence: number;
  rechecked: boolean;
};

export type AudioCandidateKind =
  | "pause"
  | "speaker_change"
  | "silence"
  | "music"
  | "sound"
  | "waveform_minimum"
  | "level_change";

export type AudioCandidateRecord = {
  id: string;
  timestampSeconds: number;
  kind: AudioCandidateKind;
  score: number;
  detail: string;
};

export type NotebookAnalysisEvidence = {
  visualCandidates: VisualCandidateRecord[];
  visualDecisions: VisualDecisionRecord[];
  audioCandidates: AudioCandidateRecord[];
  selectedAudioCandidateIds: string[];
  transcript: {
    included: boolean;
    timed: boolean;
    provider?: string;
    model?: string;
    transcriptId?: string;
  };
};

export type NotebookAnalysisLlmExchange = {
  provider: string;
  model: string;
  stage: string;
  input: OpenAiResponseRequest;
  response: OpenAiResponseResponse;
};

export type NotebookLiveAnalysis = {
  rawOutput: {
    shots: Array<{
      startSeconds: number;
      endSeconds: number;
      label: string;
      prompt: string;
    }>;
  };
  sourceDurationSeconds: number;
  request: Record<string, unknown>;
  llmExchanges: NotebookAnalysisLlmExchange[];
  evidence: NotebookAnalysisEvidence;
  boundaries: AnalysisBoundary[];
};

type CandidateFrame = {
  timestampSeconds: number;
  offsetSeconds: number;
  dataUrl: string;
};

export type AnalysisVisualEvidenceInput = {
  id?: string;
  timestampSeconds: number;
  score: number;
  frames: CandidateFrame[];
};

type AnalyzeNotebookSourceOptions = {
  sourceDurationSeconds?: number;
  responses?: ResponsesFn;
  signal?: AbortSignal;
  visualEvidence?: AnalysisVisualEvidenceInput[];
};

type FrameInput = {
  name: string;
  timestampSeconds: number;
  dataUrl: string;
};

type CandidateFrameSet = {
  candidate: VisualCandidateRecord;
  frames: CandidateFrame[];
};

type TranscriptContext = {
  text: string | null;
  timedTranscript: Transcript | null;
  provider?: string;
  model?: string;
  transcriptId?: string;
};

type BoundaryTarget = {
  id: string;
  intervalId: string;
  idealSeconds: number;
  optionIds: string[];
};

type PreliminaryShot = {
  id: string;
  startSeconds: number;
  endSeconds: number;
  startBoundaryKind: AnalysisBoundaryKind;
  endBoundaryKind: AnalysisBoundaryKind;
};

const CAMERA_VALIDATION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    decisions: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidateId: { type: "string", minLength: 1 },
          cameraSwitch: { type: "boolean" },
          transitionType: {
            type: "string",
            enum: ["hard_cut", "dissolve", "false_positive"],
          },
          confidence: { type: "number", minimum: 0, maximum: 1 },
        },
        required: [
          "candidateId",
          "cameraSwitch",
          "transitionType",
          "confidence",
        ],
      },
    },
  },
  required: ["decisions"],
};

const AUDIO_SELECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    selections: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          targetId: { type: "string", minLength: 1 },
          candidateId: { type: ["string", "null"] },
        },
        required: ["targetId", "candidateId"],
      },
    },
  },
  required: ["selections"],
};

const SHOT_LABEL_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  properties: {
    shots: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          shotId: { type: "string", minLength: 1 },
          label: { type: "string", minLength: 1 },
          prompt: { type: "string", minLength: 1 },
        },
        required: ["shotId", "label", "prompt"],
      },
    },
  },
  required: ["shots"],
};

const CameraValidationSchema = z.object({
  decisions: z.array(z.object({
    candidateId: z.string().min(1),
    cameraSwitch: z.boolean(),
    transitionType: z.enum(["hard_cut", "dissolve", "false_positive"]),
    confidence: z.number().min(0).max(1),
  }).strict()),
}).strict();

const AudioSelectionSchema = z.object({
  selections: z.array(z.object({
    targetId: z.string().min(1),
    candidateId: z.string().min(1).nullable(),
  }).strict()),
}).strict();

const ShotLabelSchema = z.object({
  shots: z.array(z.object({
    shotId: z.string().min(1),
    label: z.string().min(1),
    prompt: z.string().min(1),
  }).strict()).min(1),
}).strict();

function roundTime(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function frameTimestamp(name: string): number | null {
  const value = Number.parseFloat(name);
  return Number.isFinite(value) && value >= 0 ? value : null;
}

function frameMime(name: string): "image/jpeg" | "image/png" | "image/webp" {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "webp") return "image/webp";
  return "image/jpeg";
}

function decode(value: Buffer | string | Uint8Array): string {
  if (typeof value === "string") return value;
  return new TextDecoder().decode(value);
}

function transcriptText(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const text = (value as Record<string, unknown>).text;
  return typeof text === "string" && text.trim() ? text.trim() : null;
}

function audioMime(name: string): string {
  const extension = name.split(".").at(-1)?.toLowerCase();
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  if (extension === "m4a") return "audio/mp4";
  if (extension === "webm" || extension === "weba") return "audio/webm";
  return "application/octet-stream";
}

function sourceSeconds(
  tick: number,
  timeBase: { numerator: number; denominator: number },
): number {
  return tick * timeBase.numerator / timeBase.denominator;
}

async function readTranscript(
  engine: Engine,
  sourceArtifactId: string,
): Promise<TranscriptContext> {
  const listed = await engine.transcripts.list(sourceArtifactId);
  if (listed.ok) {
    const transcript = [...listed.value]
      .reverse()
      .find((candidate) => candidate.payloadAvailable);
    if (transcript) {
      const text = transcript.segments
        .map((segment) => segment.text.trim())
        .filter(Boolean)
        .join(" ");
      return {
        text: text || null,
        timedTranscript: transcript,
        ...(transcript.provider ? { provider: transcript.provider } : {}),
        ...(transcript.model ? { model: transcript.model } : {}),
        transcriptId: transcript.transcriptId,
      };
    }
  }
  for (const filename of ["elevenlabs.json", ".analysis.gpt4otrans.json"]) {
    const read = await engine.files.read(sourceArtifactId, filename);
    if (!read.ok) continue;
    try {
      const text = transcriptText(JSON.parse(decode(read.value)) as unknown);
      if (text) return { text, timedTranscript: null };
    } catch {
      continue;
    }
  }
  return { text: null, timedTranscript: null };
}

async function transcribeMissingText(
  engine: Engine,
  sourceArtifactId: string,
  transcript: TranscriptContext,
  signal?: AbortSignal,
): Promise<TranscriptContext> {
  if (transcript.text) return transcript;
  const apiKey = getApiKey("OPENAI_API_KEY");
  if (!apiKey) return transcript;
  const manifest = await engine.files.manifest(sourceArtifactId);
  if (!manifest.ok) return transcript;
  const audio = findAudioFile(manifest.value.files, sourceArtifactId)
    ?? manifest.value.files.find((file) =>
      /\.(?:mp3|wav|m4a|aac|ogg|flac|weba)$/i.test(file.name));
  if (!audio) return transcript;
  const read = await engine.files.read(sourceArtifactId, audio.name);
  if (!read.ok || read.value.byteLength > 24 * 1024 * 1024) return transcript;
  try {
    const provider = createOpenAi({ apiKey, timeout: 120_000 });
    const file = new File(
      [new Uint8Array(read.value)],
      audio.name,
      { type: audioMime(audio.name) },
    );
    const result = await provider.post.v1.audio.transcriptions({
      file,
      model: "gpt-transcribe",
    }, signal);
    const text = result.text.trim();
    if (!text) return transcript;
    await engine.files.write(
      sourceArtifactId,
      ".analysis.gpt4otrans.json",
      JSON.stringify({
        text,
        provider: "openai",
        model: "gpt-transcribe",
      }, null, 2),
    );
    return {
      ...transcript,
      text,
      provider: "openai",
      model: "gpt-transcribe",
    };
  } catch {
    return transcript;
  }
}

async function readDuration(
  engine: Engine,
  sourceArtifactId: string,
  configuredDuration: number | undefined,
): Promise<number> {
  if (typeof configuredDuration === "number" && configuredDuration > 0) {
    return configuredDuration;
  }
  const metadata = await engine.metadata.artifacts.read<{ duration?: number }>(
    sourceArtifactId,
    "original",
  );
  const duration = metadata.ok ? metadata.value.duration : undefined;
  if (
    typeof duration !== "number"
    || !Number.isFinite(duration)
    || duration <= 0
  ) {
    throw new Error(
      `Analyze source ${sourceArtifactId} requires a positive source duration; process the video or set sourceDurationSeconds`,
    );
  }
  return duration;
}

export function sampleNotebookAnalysisFrames(
  names: string[],
  limit = MAX_ANALYSIS_FRAMES,
): Array<{ name: string; timestampSeconds: number }> {
  const chronological = names
    .flatMap((name) => {
      if (!/\.(?:jpe?g|png|webp)$/i.test(name)) return [];
      const timestampSeconds = frameTimestamp(name);
      return timestampSeconds === null ? [] : [{ name, timestampSeconds }];
    })
    .sort((left, right) =>
      left.timestampSeconds - right.timestampSeconds
      || left.name.localeCompare(right.name));
  if (chronological.length <= limit) return chronological;
  const step = (chronological.length - 1) / (limit - 1);
  return Array.from(
    { length: limit },
    (_, index) => chronological[Math.round(index * step)]!,
  );
}

async function readFrames(
  engine: Engine,
  sourceArtifactId: string,
): Promise<FrameInput[]> {
  const listed = await engine.files.listSubdir(
    sourceArtifactId,
    "original_frames",
  );
  if (!listed.ok) {
    throw new Error(
      `Analyze source ${sourceArtifactId} requires processed original_frames; run video processing first`,
    );
  }
  const sampled = sampleNotebookAnalysisFrames(listed.value);
  if (sampled.length === 0) {
    throw new Error(
      `Analyze source ${sourceArtifactId} requires processed original_frames with at least one timestamped image; run video processing first`,
    );
  }
  const frames: FrameInput[] = [];
  for (const frame of sampled) {
    const read = await engine.files.read(
      sourceArtifactId,
      `original_frames/${frame.name}`,
    );
    if (!read.ok) continue;
    const bytes = Buffer.from(read.value);
    frames.push({
      ...frame,
      dataUrl: `data:${frameMime(frame.name)};base64,${bytes.toString("base64")}`,
    });
  }
  if (frames.length === 0) {
    throw new Error(
      `Analyze source ${sourceArtifactId} could not read any sampled original_frames`,
    );
  }
  return frames;
}

async function mapConcurrent<T, R>(
  values: T[],
  concurrency: number,
  operation: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const output = new Array<R>(values.length);
  let cursor = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, values.length) },
    async () => {
      while (cursor < values.length) {
        const index = cursor;
        cursor += 1;
        output[index] = await operation(values[index]!, index);
      }
    },
  );
  await Promise.all(workers);
  return output;
}

function clusterCandidates(
  candidates: CameraCandidate[],
  clusterSeconds = 0.25,
): CameraCandidate[] {
  const clustered: CameraCandidate[] = [];
  for (const candidate of [...candidates].sort((left, right) => left.t - right.t)) {
    const previous = clustered.at(-1);
    if (!previous || candidate.t - previous.t > clusterSeconds) {
      clustered.push(candidate);
      continue;
    }
    if (candidate.score > previous.score) {
      clustered[clustered.length - 1] = candidate;
    }
  }
  return clustered;
}

async function extractCandidateFrame(
  videoPath: string,
  timestampSeconds: number,
  offsetSeconds: number,
  duration: number,
  signal?: AbortSignal,
): Promise<CandidateFrame> {
  const timestamp = Math.max(
    0,
    Math.min(Math.max(0, duration - 0.001), timestampSeconds + offsetSeconds),
  );
  const directory = await mkdtemp(join(tmpdir(), "vb-analysis-frame-"));
  const outputPath = join(directory, "frame.jpg");
  try {
    await runFfmpeg([
      "-y",
      "-ss",
      String(timestamp),
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=1024:-2:force_original_aspect_ratio=decrease",
      "-q:v",
      "2",
      outputPath,
    ], { signal });
    const bytes = await readFile(outputPath);
    return {
      timestampSeconds: roundTime(timestamp),
      offsetSeconds,
      dataUrl: `data:image/jpeg;base64,${bytes.toString("base64")}`,
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function collectVisualEvidence(
  engine: Engine,
  sourceArtifactId: string,
  duration: number,
  signal?: AbortSignal,
): Promise<CandidateFrameSet[]> {
  const source = await materializeArtifactFile(engine, sourceArtifactId, [
    "original.mp4",
    "original.mov",
  ]);
  try {
    const samples = await detectSceneSamples(source.path, {
      fps: 4,
      signal,
    });
    const coarse = deriveCameraCandidates(samples);
    const refined = await mapConcurrent(
      coarse,
      CAMERA_BATCH_CONCURRENCY,
      (candidate) => refineCameraCandidate(source.path, candidate, signal),
    );
    const candidates = clusterCandidates(refined)
      .filter((candidate) =>
        candidate.t > 0.05 && candidate.t < duration - 0.05);
    return await mapConcurrent(
      candidates,
      CAMERA_BATCH_CONCURRENCY,
      async (candidate, index) => {
        const frames = await mapConcurrent(
          [...CAMERA_FRAME_OFFSETS],
          2,
          (offset) =>
            extractCandidateFrame(
              source.path,
              candidate.t,
              offset,
              duration,
              signal,
            ),
        );
        return {
          candidate: {
            id: `visual-${String(index + 1).padStart(3, "0")}`,
            timestampSeconds: roundTime(candidate.t),
            score: roundTime(candidate.score),
            frameTimestamps: frames.map((frame) => frame.timestampSeconds),
          },
          frames,
        };
      },
    );
  } finally {
    await source.cleanup();
  }
}

function suppliedVisualEvidence(
  evidence: AnalysisVisualEvidenceInput[],
): CandidateFrameSet[] {
  return evidence
    .filter((candidate) =>
      Number.isFinite(candidate.timestampSeconds)
      && candidate.timestampSeconds > 0)
    .sort((left, right) => left.timestampSeconds - right.timestampSeconds)
    .map((candidate, index) => ({
      candidate: {
        id: candidate.id ?? `visual-${String(index + 1).padStart(3, "0")}`,
        timestampSeconds: roundTime(candidate.timestampSeconds),
        score: roundTime(candidate.score),
        frameTimestamps: candidate.frames.map((frame) =>
          roundTime(frame.timestampSeconds)),
      },
      frames: candidate.frames,
    }));
}

function cameraValidationContent(
  candidates: CandidateFrameSet[],
  recheck: boolean,
): OpenAiResponseInputContent[] {
  const content: OpenAiResponseInputContent[] = [{
    type: "input_text",
    text: recheck
      ? "Recheck each ambiguous candidate using all four frames. A camera switch changes the editorial shot or camera view; reject subject motion, zooms, pans, flashes, overlays, and compression artifacts."
      : "Verify whether each candidate is a real editorial camera switch. Use the narrow before/after pair first. Reject subject motion, zooms, pans, flashes, overlays, and compression artifacts.",
  }];
  for (const entry of candidates) {
    content.push({
      type: "input_text",
      text: `Candidate ${entry.candidate.id} at ${entry.candidate.timestampSeconds.toFixed(3)} seconds; local score ${entry.candidate.score.toFixed(3)}.`,
    });
    const frames = recheck
      ? entry.frames
      : entry.frames.filter((frame) => Math.abs(frame.offsetSeconds) <= 0.11);
    for (const frame of frames) {
      content.push({
        type: "input_text",
        text: `Candidate ${entry.candidate.id}, offset ${frame.offsetSeconds.toFixed(1)} seconds, source time ${frame.timestampSeconds.toFixed(3)} seconds.`,
      });
      content.push({
        type: "input_image",
        image_url: frame.dataUrl,
        detail: "high",
      });
    }
  }
  return content;
}

async function requestCameraDecisions(
  responses: ResponsesFn,
  candidates: CandidateFrameSet[],
  recheck: boolean,
  signal?: AbortSignal,
): Promise<z.infer<typeof CameraValidationSchema>["decisions"]> {
  const batches = Array.from(
    { length: Math.ceil(candidates.length / CAMERA_BATCH_SIZE) },
    (_, index) =>
      candidates.slice(
        index * CAMERA_BATCH_SIZE,
        (index + 1) * CAMERA_BATCH_SIZE,
      ),
  );
  const outputs = await mapConcurrent(
    batches,
    CAMERA_BATCH_CONCURRENCY,
    async (batch) => {
      const response = await responses(intelligenceRequest({
        instructions: "Return one decision for every supplied candidate ID. Do not add candidate IDs or timestamps.",
        input: [{
          role: "user",
          content: cameraValidationContent(batch, recheck),
        }],
        text: {
          format: {
            type: "json_schema",
            name: "notebook_camera_cut_validation",
            schema: CAMERA_VALIDATION_JSON_SCHEMA,
            strict: true,
          },
        },
        max_output_tokens: 2048,
      }, { reasoningEffort: ANALYSIS_REASONING_EFFORT }), signal);
      return CameraValidationSchema.parse(
        JSON.parse(firstResponseText(response)) as unknown,
      ).decisions;
    },
  );
  return outputs.flat();
}

async function validateCameraCandidates(
  responses: ResponsesFn,
  candidates: CandidateFrameSet[],
  signal?: AbortSignal,
): Promise<VisualDecisionRecord[]> {
  if (candidates.length === 0) return [];
  const initial = await requestCameraDecisions(
    responses,
    candidates,
    false,
    signal,
  );
  const initialById = new Map(initial.map((decision) => [
    decision.candidateId,
    decision,
  ]));
  const ambiguous = candidates.filter((candidate) => {
    const decision = initialById.get(candidate.candidate.id);
    return !decision || decision.confidence < CAMERA_ACCEPT_CONFIDENCE;
  });
  const rechecked = ambiguous.length > 0
    ? await requestCameraDecisions(responses, ambiguous, true, signal)
    : [];
  const recheckedById = new Map(rechecked.map((decision) => [
    decision.candidateId,
    decision,
  ]));
  return candidates.map((candidate) => {
    const first = initialById.get(candidate.candidate.id);
    const second = recheckedById.get(candidate.candidate.id);
    const decision = second ?? first;
    const threshold = second
      ? CAMERA_RECHECK_CONFIDENCE
      : CAMERA_ACCEPT_CONFIDENCE;
    const accepted = decision?.cameraSwitch === true
      && decision.confidence >= threshold;
    return {
      candidateId: candidate.candidate.id,
      accepted,
      cameraSwitch: decision?.cameraSwitch ?? false,
      transitionType: accepted
        ? decision?.transitionType === "dissolve"
          ? "dissolve"
          : "hard_cut"
        : "false_positive",
      confidence: roundTime(decision?.confidence ?? 0),
      rechecked: second !== undefined,
    };
  });
}

function audioCandidateDrafts(
  transcript: Transcript | null,
  waveform: number[],
  duration: number,
): Array<Omit<AudioCandidateRecord, "id">> {
  const candidates: Array<Omit<AudioCandidateRecord, "id">> = [];
  if (transcript) {
    const speechSegments = transcript.segments
      .filter((segment) => segment.kind === "speech")
      .sort((left, right) =>
        sourceSeconds(left.range.startTick, left.range.timeBase)
        - sourceSeconds(right.range.startTick, right.range.timeBase));
    const words = speechSegments
      .flatMap((segment) =>
        segment.words.map((word) => ({
          speaker: segment.speaker,
          text: word.text.trim(),
          startSeconds: sourceSeconds(word.startTick, segment.range.timeBase),
          endSeconds: sourceSeconds(
            word.startTick + word.durationTicks,
            segment.range.timeBase,
          ),
        })))
      .sort((left, right) => left.startSeconds - right.startSeconds);
    for (let index = 1; index < words.length; index += 1) {
      const previous = words[index - 1]!;
      const current = words[index]!;
      const gap = current.startSeconds - previous.endSeconds;
      if (gap >= 0.75) {
        candidates.push({
          timestampSeconds: roundTime(
            previous.endSeconds + gap / 2,
          ),
          kind: "pause",
          score: Math.min(1, gap / 2),
          detail: `${gap.toFixed(2)} second pause between "${previous.text}" and "${current.text}"`,
        });
      }
      if (
        previous.speaker
        && current.speaker
        && previous.speaker !== current.speaker
      ) {
        candidates.push({
          timestampSeconds: roundTime(current.startSeconds),
          kind: "speaker_change",
          score: 0.8,
          detail: `Speaker change before "${current.text}"`,
        });
      }
    }
    for (const segment of transcript.segments) {
      if (segment.kind === "speech" || segment.kind === "other") continue;
      const start = sourceSeconds(
        segment.range.startTick,
        segment.range.timeBase,
      );
      const end = sourceSeconds(
        segment.range.startTick + segment.range.durationTicks,
        segment.range.timeBase,
      );
      const kind = segment.kind;
      const score = kind === "silence" ? 0.9 : kind === "music" ? 0.75 : 0.65;
      candidates.push({
        timestampSeconds: roundTime(start),
        kind,
        score,
        detail: `${kind} begins`,
      });
      candidates.push({
        timestampSeconds: roundTime(end),
        kind,
        score,
        detail: `${kind} ends`,
      });
    }
  }
  if (waveform.length > 2 && duration > 0) {
    const secondsPerPeak = duration / waveform.length;
    const radius = Math.max(1, Math.round(0.5 / secondsPerPeak));
    for (let index = 1; index < waveform.length - 1; index += 1) {
      const value = waveform[index]!;
      const start = Math.max(0, index - radius);
      const end = Math.min(waveform.length, index + radius + 1);
      const window = waveform.slice(start, end);
      if (value <= 0.15 && value === Math.min(...window)) {
        candidates.push({
          timestampSeconds: roundTime((index + 0.5) * secondsPerPeak),
          kind: "waveform_minimum",
          score: 1 - value,
          detail: "Local audio-energy minimum",
        });
      }
      const delta = Math.abs(value - waveform[index - 1]!);
      if (delta >= 0.35) {
        candidates.push({
          timestampSeconds: roundTime((index + 0.5) * secondsPerPeak),
          kind: "level_change",
          score: Math.min(1, delta),
          detail: "Abrupt audio-level change",
        });
      }
    }
  }
  return candidates;
}

export function buildAudioCandidates(
  transcript: Transcript | null,
  waveform: number[],
  duration: number,
): AudioCandidateRecord[] {
  const drafts = audioCandidateDrafts(transcript, waveform, duration)
    .filter((candidate) =>
      candidate.timestampSeconds > 0.25
      && candidate.timestampSeconds < duration - 0.25)
    .sort((left, right) =>
      left.timestampSeconds - right.timestampSeconds
      || right.score - left.score);
  const deduplicated: Array<Omit<AudioCandidateRecord, "id">> = [];
  for (const candidate of drafts) {
    const previous = deduplicated.at(-1);
    if (
      !previous
      || candidate.timestampSeconds - previous.timestampSeconds > 0.5
    ) {
      deduplicated.push(candidate);
      continue;
    }
    if (candidate.score > previous.score) {
      deduplicated[deduplicated.length - 1] = candidate;
    }
  }
  return deduplicated.map((candidate, index) => ({
    id: `audio-${String(index + 1).padStart(3, "0")}`,
    ...candidate,
    timestampSeconds: roundTime(candidate.timestampSeconds),
    score: roundTime(candidate.score),
  }));
}

function buildBoundaryTargets(
  cameraBoundaries: AnalysisBoundary[],
  audioCandidates: AudioCandidateRecord[],
  duration: number,
): BoundaryTarget[] {
  const visualTimes = [
    0,
    ...cameraBoundaries.map((boundary) => boundary.timestampSeconds),
    duration,
  ];
  const targets: BoundaryTarget[] = [];
  for (let intervalIndex = 0; intervalIndex < visualTimes.length - 1; intervalIndex += 1) {
    const start = visualTimes[intervalIndex]!;
    const end = visualTimes[intervalIndex + 1]!;
    const intervalDuration = end - start;
    const partCount = Math.max(
      1,
      Math.ceil(intervalDuration / MAX_SHOT_SECONDS),
    );
    const intervalId = `interval-${String(intervalIndex + 1).padStart(3, "0")}`;
    for (let part = 1; part < partCount; part += 1) {
      const idealSeconds = roundTime(
        start + intervalDuration * part / partCount,
      );
      const optionIds = audioCandidates
        .filter((candidate) =>
          candidate.timestampSeconds >= start + AUDIO_BOUNDARY_MIN_SPACING_SECONDS
          && candidate.timestampSeconds <= end - AUDIO_BOUNDARY_MIN_SPACING_SECONDS
          && Math.abs(candidate.timestampSeconds - idealSeconds)
            <= AUDIO_TARGET_WINDOW_SECONDS)
        .sort((left, right) =>
          right.score - left.score
          || Math.abs(left.timestampSeconds - idealSeconds)
            - Math.abs(right.timestampSeconds - idealSeconds))
        .slice(0, 12)
        .map((candidate) => candidate.id);
      targets.push({
        id: `${intervalId}-target-${String(part).padStart(2, "0")}`,
        intervalId,
        idealSeconds,
        optionIds,
      });
    }
  }
  return targets;
}

async function selectAudioCandidates(
  responses: ResponsesFn,
  targets: BoundaryTarget[],
  audioCandidates: AudioCandidateRecord[],
  signal?: AbortSignal,
): Promise<Map<string, string | null>> {
  const selectable = targets.filter((target) => target.optionIds.length > 0);
  if (selectable.length === 0) return new Map();
  const optionIds = new Set(selectable.flatMap((target) => target.optionIds));
  const options = audioCandidates.filter((candidate) =>
    optionIds.has(candidate.id));
  const response = await responses(intelligenceRequest({
    instructions: [
      "Select at most one supplied audio candidate for each target.",
      "Prefer clean pauses, speaker or music transitions, then strong waveform changes.",
      "Return null when no option is a credible editorial boundary.",
      "Do not add IDs or timestamps.",
    ].join("\n"),
    input: [{
      role: "user",
      content: [{
        type: "input_text",
        text: JSON.stringify({ targets: selectable, candidates: options }),
      }],
    }],
    text: {
      format: {
        type: "json_schema",
        name: "notebook_audio_boundary_selection",
        schema: AUDIO_SELECTION_JSON_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 2048,
  }, { reasoningEffort: ANALYSIS_REASONING_EFFORT }), signal);
  const parsed = AudioSelectionSchema.parse(
    JSON.parse(firstResponseText(response)) as unknown,
  );
  return new Map(parsed.selections.map((selection) => [
    selection.targetId,
    selection.candidateId,
  ]));
}

function selectedAudioBoundaries(
  targets: BoundaryTarget[],
  selections: Map<string, string | null>,
  audioCandidates: AudioCandidateRecord[],
  cameraBoundaries: AnalysisBoundary[],
  duration: number,
): AnalysisBoundary[] {
  const candidateById = new Map(audioCandidates.map((candidate) => [
    candidate.id,
    candidate,
  ]));
  const targetsByInterval = new Map<string, BoundaryTarget[]>();
  for (const target of targets) {
    const entries = targetsByInterval.get(target.intervalId) ?? [];
    entries.push(target);
    targetsByInterval.set(target.intervalId, entries);
  }
  const visualTimes = [
    0,
    ...cameraBoundaries.map((boundary) => boundary.timestampSeconds),
    duration,
  ];
  const output: AnalysisBoundary[] = [];
  for (let intervalIndex = 0; intervalIndex < visualTimes.length - 1; intervalIndex += 1) {
    const intervalId = `interval-${String(intervalIndex + 1).padStart(3, "0")}`;
    const intervalTargets = targetsByInterval.get(intervalId) ?? [];
    if (intervalTargets.length === 0) continue;
    const start = visualTimes[intervalIndex]!;
    const end = visualTimes[intervalIndex + 1]!;
    const proposed = intervalTargets.map((target) => {
      const selectedId = selections.get(target.id);
      const selected = selectedId && target.optionIds.includes(selectedId)
        ? candidateById.get(selectedId)
        : undefined;
      return selected
        ? {
            target,
            timestampSeconds: selected.timestampSeconds,
            candidate: selected,
          }
        : {
            target,
            timestampSeconds: target.idealSeconds,
            candidate: undefined,
          };
    }).sort((left, right) =>
      left.timestampSeconds - right.timestampSeconds);
    const times = [start, ...proposed.map((entry) => entry.timestampSeconds), end];
    const valid = times.every((time, index) => {
      if (index === 0) return true;
      const spacing = time - times[index - 1]!;
      return spacing >= AUDIO_BOUNDARY_MIN_SPACING_SECONDS
        && spacing <= MAX_SHOT_SECONDS + 0.001;
    });
    const entries = valid
      ? proposed
      : intervalTargets.map((target) => ({
          target,
          timestampSeconds: target.idealSeconds,
          candidate: undefined,
        }));
    for (const entry of entries) {
      output.push(entry.candidate
        ? {
            id: `boundary-${entry.candidate.id}`,
            timestampSeconds: entry.candidate.timestampSeconds,
            kind: "audio_transition",
            confidence: entry.candidate.score,
            evidenceIds: [entry.candidate.id],
          }
        : {
            id: `boundary-${entry.target.id}`,
            timestampSeconds: entry.target.idealSeconds,
            kind: "duration_fallback",
            confidence: 0,
            evidenceIds: [],
          });
    }
  }
  return output;
}

function preliminaryShots(
  boundaries: AnalysisBoundary[],
): PreliminaryShot[] {
  return boundaries.slice(0, -1).map((boundary, index) => {
    const next = boundaries[index + 1]!;
    return {
      id: `shot-${String(index + 1).padStart(3, "0")}`,
      startSeconds: boundary.timestampSeconds,
      endSeconds: next.timestampSeconds,
      startBoundaryKind: boundary.kind,
      endBoundaryKind: next.kind,
    };
  });
}

function shotLabelContent(
  prompt: string,
  duration: number,
  shots: PreliminaryShot[],
  boundaries: AnalysisBoundary[],
  frames: FrameInput[],
  transcript: string | null,
): OpenAiResponseInputContent[] {
  const content: OpenAiResponseInputContent[] = [{
    type: "input_text",
    text: [
      `Analysis brief:\n${prompt}`,
      `Source duration: ${duration} seconds`,
      `Immutable boundaries:\n${JSON.stringify(boundaries)}`,
      `Shots to label:\n${JSON.stringify(shots)}`,
      transcript
        ? `Transcript:\n${transcript.slice(0, 30_000)}`
        : "Transcript: unavailable",
    ].join("\n\n"),
  }];
  for (const frame of frames) {
    content.push({
      type: "input_text",
      text: `Frame timestamp: ${frame.timestampSeconds.toFixed(3)} seconds`,
    });
    content.push({
      type: "input_image",
      image_url: frame.dataUrl,
      detail: "high",
    });
  }
  return content;
}

function llmExchangeStage(request: OpenAiResponseRequest): string {
  const format = request.text?.format;
  return format?.type === "json_schema"
    ? format.name
    : "openai_responses";
}

async function labelShots(
  responses: ResponsesFn,
  prompt: string,
  duration: number,
  shots: PreliminaryShot[],
  boundaries: AnalysisBoundary[],
  frames: FrameInput[],
  transcript: string | null,
  signal?: AbortSignal,
): Promise<NotebookLiveAnalysis["rawOutput"]> {
  const response = await responses(intelligenceRequest({
    instructions: [
      "Return one concise evidence-grounded label and visual prompt for every supplied shotId.",
      "Do not add, remove, merge, split, or rename shot IDs.",
      "Do not invent people, objects, dialogue, or events.",
    ].join("\n"),
    input: [{
      role: "user",
      content: shotLabelContent(
        prompt,
        duration,
        shots,
        boundaries,
        frames,
        transcript,
      ),
    }],
    text: {
      format: {
        type: "json_schema",
        name: "notebook_shot_labels",
        schema: SHOT_LABEL_JSON_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 4096,
  }, { reasoningEffort: ANALYSIS_REASONING_EFFORT }), signal);
  const parsed = ShotLabelSchema.parse(
    JSON.parse(firstResponseText(response)) as unknown,
  );
  const labels = new Map(parsed.shots.map((shot) => [shot.shotId, shot]));
  return {
    shots: shots.map((shot, index) => {
      const label = labels.get(shot.id);
      return {
        startSeconds: roundTime(shot.startSeconds),
        endSeconds: roundTime(shot.endSeconds),
        label: label?.label.trim() || `Shot ${index + 1}`,
        prompt: label?.prompt.trim()
          || `Visual continuity from ${shot.startSeconds.toFixed(3)} to ${shot.endSeconds.toFixed(3)} seconds.`,
      };
    }),
  };
}

export async function analyzeNotebookSource(
  engine: Engine,
  sourceArtifactId: string,
  prompt: string,
  options: AnalyzeNotebookSourceOptions = {},
): Promise<NotebookLiveAnalysis> {
  const duration = await readDuration(
    engine,
    sourceArtifactId,
    options.sourceDurationSeconds,
  );
  const frames = await readFrames(engine, sourceArtifactId);
  const transcript = await transcribeMissingText(
    engine,
    sourceArtifactId,
    await readTranscript(engine, sourceArtifactId),
    options.signal,
  );
  const waveformResult = await engine.metadata.waveforms.read(sourceArtifactId);
  const waveform = waveformResult.ok ? waveformResult.value.peaks : [];
  const audioCandidates = buildAudioCandidates(
    transcript.timedTranscript,
    waveform,
    duration,
  );
  const visualEvidence = options.visualEvidence
    ? suppliedVisualEvidence(options.visualEvidence)
    : await collectVisualEvidence(
        engine,
        sourceArtifactId,
        duration,
        options.signal,
      );
  const providerResponses = options.responses
    ?? buildIntelligenceResponses(
      getApiKey("OPENAI_API_KEY") ?? undefined,
    );
  const llmExchanges: Array<NotebookAnalysisLlmExchange | null> = [];
  const responses: ResponsesFn = async (request, signal) => {
    const exchangeIndex = llmExchanges.length;
    llmExchanges.push(null);
    const response = await providerResponses(request, signal);
    llmExchanges[exchangeIndex] = {
      provider: "openai",
      model: request.model,
      stage: llmExchangeStage(request),
      input: request,
      response,
    };
    return response;
  };
  const visualDecisions = await validateCameraCandidates(
    responses,
    visualEvidence,
    options.signal,
  );
  const visualById = new Map(visualEvidence.map((entry) => [
    entry.candidate.id,
    entry.candidate,
  ]));
  const cameraBoundaries = visualDecisions
    .filter((decision) => decision.accepted)
    .flatMap((decision) => {
      const candidate = visualById.get(decision.candidateId);
      return candidate
        ? [{
            id: `boundary-${candidate.id}`,
            timestampSeconds: candidate.timestampSeconds,
            kind: "camera_cut" as const,
            confidence: decision.confidence,
            evidenceIds: [candidate.id],
          }]
        : [];
    })
    .sort((left, right) =>
      left.timestampSeconds - right.timestampSeconds);
  const targets = buildBoundaryTargets(
    cameraBoundaries,
    audioCandidates,
    duration,
  );
  const audioSelections = await selectAudioCandidates(
    responses,
    targets,
    audioCandidates,
    options.signal,
  );
  const audioBoundaries = selectedAudioBoundaries(
    targets,
    audioSelections,
    audioCandidates,
    cameraBoundaries,
    duration,
  );
  const sourceStartBoundary: AnalysisBoundary = {
    id: "boundary-source-start",
    timestampSeconds: 0,
    kind: "source_start",
    confidence: 1,
    evidenceIds: [],
  };
  const sourceEndBoundary: AnalysisBoundary = {
    id: "boundary-source-end",
    timestampSeconds: roundTime(duration),
    kind: "source_end",
    confidence: 1,
    evidenceIds: [],
  };
  const boundaries: AnalysisBoundary[] = [
    sourceStartBoundary,
    ...cameraBoundaries,
    ...audioBoundaries,
    sourceEndBoundary,
  ].sort((left, right) =>
    left.timestampSeconds - right.timestampSeconds);
  const shots = preliminaryShots(boundaries);
  const rawOutput = await labelShots(
    responses,
    prompt,
    duration,
    shots,
    boundaries,
    frames,
    transcript.text,
    options.signal,
  );
  const selectedAudioCandidateIds = audioBoundaries
    .flatMap((boundary) =>
      boundary.kind === "audio_transition" ? boundary.evidenceIds : []);
  const evidence: NotebookAnalysisEvidence = {
    visualCandidates: visualEvidence.map((entry) => entry.candidate),
    visualDecisions,
    audioCandidates,
    selectedAudioCandidateIds,
    transcript: {
      included: transcript.text !== null,
      timed: transcript.timedTranscript !== null,
      ...(transcript.provider ? { provider: transcript.provider } : {}),
      ...(transcript.model ? { model: transcript.model } : {}),
      ...(transcript.transcriptId
        ? { transcriptId: transcript.transcriptId }
        : {}),
    },
  };
  return {
    rawOutput,
    sourceDurationSeconds: duration,
    llmExchanges: llmExchanges.filter(
      (exchange): exchange is NotebookAnalysisLlmExchange => exchange !== null,
    ),
    evidence,
    boundaries,
    request: {
      provider: "openai",
      model: INTELLIGENCE_MODEL,
      reasoning: { effort: ANALYSIS_REASONING_EFFORT },
      mode: "live",
      pipelineVersion: 3,
      prompt,
      sourceArtifactId,
      sourceDurationSeconds: duration,
      stages: [
        "visual_candidate_detection",
        "camera_validation",
        "audio_boundary_selection",
        "shot_labeling",
      ],
      frameTimestamps: frames.map((frame) => frame.timestampSeconds),
      visualCandidateCount: visualEvidence.length,
      acceptedCameraCutCount: cameraBoundaries.length,
      audioCandidateCount: audioCandidates.length,
      selectedAudioBoundaryCount: selectedAudioCandidateIds.length,
      durationFallbackCount: audioBoundaries.filter((boundary) =>
        boundary.kind === "duration_fallback").length,
      transcriptIncluded: transcript.text !== null,
      timedTranscriptIncluded: transcript.timedTranscript !== null,
    },
  };
}
