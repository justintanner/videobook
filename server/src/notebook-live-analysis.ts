import type { OpenAiResponseInputContent } from "@apicity/openai";
import { z } from "zod";
import type { Engine } from "videobook-engine";
import { getApiKey } from "./api-key.js";
import {
  INTELLIGENCE_MODEL,
  INTELLIGENCE_REASONING_EFFORT,
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
  type ResponsesFn,
} from "./openai-intelligence.js";

const MAX_ANALYSIS_FRAMES = 15;

const SHOTS_JSON_SCHEMA: Record<string, unknown> = {
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
          startSeconds: { type: "number", minimum: 0 },
          endSeconds: { type: "number", exclusiveMinimum: 0 },
          label: { type: "string", minLength: 1 },
          prompt: { type: "string", minLength: 1 },
        },
        required: ["startSeconds", "endSeconds", "label", "prompt"],
      },
    },
  },
  required: ["shots"],
};

const AnalysisShotSchema = z.object({
  startSeconds: z.number().min(0),
  endSeconds: z.number().positive(),
  label: z.string().min(1),
  prompt: z.string().min(1),
}).strict().refine(
  (shot) => shot.endSeconds > shot.startSeconds,
  "Shot endSeconds must be greater than startSeconds",
);

const AnalysisResponseSchema = z.object({
  shots: z.array(AnalysisShotSchema).min(1),
}).strict();

export type NotebookLiveAnalysis = {
  rawOutput: z.infer<typeof AnalysisResponseSchema>;
  sourceDurationSeconds: number;
  request: Record<string, unknown>;
};

type AnalyzeNotebookSourceOptions = {
  sourceDurationSeconds?: number;
  responses?: ResponsesFn;
  signal?: AbortSignal;
};

type FrameInput = {
  name: string;
  timestampSeconds: number;
  dataUrl: string;
};

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

async function readTranscript(
  engine: Engine,
  sourceArtifactId: string,
): Promise<string | null> {
  for (const filename of ["elevenlabs.json", ".analysis.gpt4otrans.json"]) {
    const read = await engine.files.read(sourceArtifactId, filename);
    if (!read.ok) continue;
    try {
      const text = transcriptText(JSON.parse(decode(read.value)) as unknown);
      if (text) return text;
    } catch {
      continue;
    }
  }
  return null;
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
  if (typeof duration !== "number" || !Number.isFinite(duration) || duration <= 0) {
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

function analysisInstructions(duration: number): string {
  return [
    "Analyze chronological sampled frames from one processed source video.",
    `Return continuous narrative shots covering 0 through ${duration} seconds.`,
    "Each shot should be 4 to 15 seconds when the source duration permits.",
    "Use precise startSeconds and endSeconds, a concise label, and a visual prompt describing subjects, action, setting, composition, and continuity.",
    "Do not invent people, objects, dialogue, or events that are not supported by the frames or transcript.",
  ].join("\n");
}

function analysisContent(
  prompt: string,
  duration: number,
  frames: FrameInput[],
  transcript: string | null,
): OpenAiResponseInputContent[] {
  const content: OpenAiResponseInputContent[] = [{
    type: "input_text",
    text: [
      `Analysis brief:\n${prompt}`,
      `Source duration: ${duration} seconds`,
      transcript ? `Transcript:\n${transcript}` : "Transcript: unavailable",
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
  const transcript = await readTranscript(engine, sourceArtifactId);
  const responses = options.responses
    ?? buildIntelligenceResponses(
      getApiKey("OPENAI_API_KEY") ?? undefined,
    );
  const response = await responses(intelligenceRequest({
    instructions: analysisInstructions(duration),
    input: [{
      role: "user",
      content: analysisContent(prompt, duration, frames, transcript),
    }],
    text: {
      format: {
        type: "json_schema",
        name: "notebook_analysis_shots",
        schema: SHOTS_JSON_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 4096,
  }), options.signal);
  const parsed = AnalysisResponseSchema.parse(
    JSON.parse(firstResponseText(response)) as unknown,
  );
  return {
    rawOutput: parsed,
    sourceDurationSeconds: duration,
    request: {
      provider: "openai",
      model: INTELLIGENCE_MODEL,
      reasoning: { effort: INTELLIGENCE_REASONING_EFFORT },
      mode: "live",
      prompt,
      sourceArtifactId,
      sourceDurationSeconds: duration,
      frameTimestamps: frames.map((frame) => frame.timestampSeconds),
      transcriptIncluded: transcript !== null,
    },
  };
}
