import type { Engine } from "videobook-engine";
import { join } from "node:path";
import type { OpenAiResponseInputContent } from "@apicity/openai";
import { registerJobHandler, queue } from "../queue.js";
import { getApiKey } from "../api-key.js";
import {
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";
import {
  DOWNSTREAM_LEASE_WAIT_MS,
  withLocalLease,
} from "./_lease.js";
import { findAudioFile } from "videobook-engine";
import { readAndAssessDialog } from "../dialog-quality.js";
import { enqueueLazyTimelineRender } from "../lazy-render.js";

type AnalyzeVideoPayload = {
  type: "analyze_video";
  assetId: string;
  assetDir: string;
  bookId: string;
  hasTranscription: boolean;
};

const MAX_FRAMES = 15;

const FALLBACK_ANALYSIS = {
  summary: "", scenes: [], tags: [], mood: "",
  subjects: [], actions: [], setting: "", textOnScreen: [],
  burnedInSubtitles: null,
  onScreenGraphic: null,
  recommendedSubtitlePosition: "bottom",
  recommendedOsgPosition: "top-right",
  subjectPlacement: "center",
};

const SYSTEM_PROMPT = `You are a video analysis expert. Analyze the provided video frames, metadata, and transcription (if available) to produce a comprehensive JSON analysis.

Return a JSON object with these fields:
- "summary": A 2-3 sentence description of the video content
- "scenes": An array of scene descriptions, each with "timestamp" (approximate seconds), "description", and "tags" (array of strings)
- "tags": Top-level tags for the entire video (array of strings)
- "mood": The overall mood/tone of the video
- "subjects": Array of main subjects/people/objects featured
- "subjectPlacement": Horizontal placement of the primary subject across the sampled frames: "left", "center", or "right"
- "actions": Array of key actions or events that occur
- "setting": Description of the environment/location
- "textOnScreen": Array of any visible text in the frames
- "burnedInSubtitles": Detect if subtitles or captions are already burned into the video frames. If detected, return an object with "detected": true, "position": one of "top", "middle", or "bottom" indicating where the text appears, and "confidence": "high", "medium", or "low". If no burned-in subtitles are found, return null. Look for persistent text overlays that appear across multiple frames in a consistent position — these are distinct from occasional on-screen titles or graphics.
- "onScreenGraphic": Detect if there is a watermark, logo, or channel graphic burned into the video. If detected, return an object with "detected": true, "position": one of "top-left", "top-right", "bottom-left", or "bottom-right" indicating the corner where it appears, "description": a brief description of what it is (e.g. "TikTok logo", "channel watermark"), and "confidence": "high", "medium", or "low". If none found, return null.
- "recommendedSubtitlePosition": Based on what is already on screen, recommend the best position ("top", "middle", or "bottom") for adding subtitle overlays that will not conflict with any detected burned-in subtitles or on-screen graphics. If burned-in subtitles are at the bottom, recommend "top". If nothing is detected, default to "bottom".
- "recommendedOsgPosition": Based on what is already on screen, recommend the best corner ("top-left", "top-right", "bottom-left", or "bottom-right") for placing an overlay graphic that will not conflict with any detected on-screen graphics. If nothing is detected, default to "top-right".`;

const ANALYZE_VIDEO_JSON_SCHEMA = {
  type: "object",
  required: [
    "summary",
    "scenes",
    "tags",
    "mood",
    "subjects",
    "subjectPlacement",
    "actions",
    "setting",
    "textOnScreen",
    "burnedInSubtitles",
    "onScreenGraphic",
    "recommendedSubtitlePosition",
    "recommendedOsgPosition",
  ],
  additionalProperties: false,
  properties: {
    summary: { type: "string" },
    scenes: {
      type: "array",
      items: {
        type: "object",
        required: ["timestamp", "description", "tags"],
        additionalProperties: false,
        properties: {
          timestamp: { type: "number" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
      },
    },
    tags: { type: "array", items: { type: "string" } },
    mood: { type: "string" },
    subjects: { type: "array", items: { type: "string" } },
    subjectPlacement: { type: "string", enum: ["left", "center", "right"] },
    actions: { type: "array", items: { type: "string" } },
    setting: { type: "string" },
    textOnScreen: { type: "array", items: { type: "string" } },
    burnedInSubtitles: {
      anyOf: [
        {
          type: "object",
          required: ["detected", "position", "confidence"],
          additionalProperties: false,
          properties: {
            detected: { type: "boolean" },
            position: { type: "string", enum: ["top", "middle", "bottom"] },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
        },
        { type: "null" },
      ],
    },
    onScreenGraphic: {
      anyOf: [
        {
          type: "object",
          required: ["detected", "position", "description", "confidence"],
          additionalProperties: false,
          properties: {
            detected: { type: "boolean" },
            position: {
              type: "string",
              enum: ["top-left", "top-right", "bottom-left", "bottom-right"],
            },
            description: { type: "string" },
            confidence: { type: "string", enum: ["high", "medium", "low"] },
          },
        },
        { type: "null" },
      ],
    },
    recommendedSubtitlePosition: {
      type: "string",
      enum: ["top", "middle", "bottom"],
    },
    recommendedOsgPosition: {
      type: "string",
      enum: ["top-left", "top-right", "bottom-left", "bottom-right"],
    },
  },
} as const;

function sampleFrames(frames: string[]): string[] {
  if (frames.length <= MAX_FRAMES) return frames;
  const step = (frames.length - 1) / (MAX_FRAMES - 1);
  return Array.from({ length: MAX_FRAMES }, (_, i) =>
    frames[Math.round(i * step)]
  );
}

export function registerAnalyzeVideoJob(fs: Engine): void {
  registerJobHandler("analyze_video", async (payload, ctx) => {
    const {
      assetId, assetDir, bookId, hasTranscription,
    } = payload as AnalyzeVideoPayload;

    const result = await withLocalLease(fs, bookId, assetId, ctx, "analyze", async () => {
    {

    const metaResult = await fs.metadata.artifacts.read<{ width: number; height: number; duration: number }>(assetId, "original"
    );
    const metadata = metaResult.ok ? metaResult.value : null;

    const listResult = await fs.files.listSubdir(assetId, "original_frames");
    const frameFiles = listResult.ok
      ? listResult.value
          .filter((f) => f.endsWith(".jpg"))
          .sort((a, b) => parseFloat(a) - parseFloat(b))
      : [];

    const sampled = sampleFrames(frameFiles);
    const frameParts: OpenAiResponseInputContent[] = [];
    for (const file of sampled) {
      const frameRead = await fs.files.read(assetId, `original_frames/${file}`);
      if (!frameRead.ok) throw new Error(frameRead.error.message);
      frameParts.push(
        { type: "input_text", text: `Frame timestamp: ${parseFloat(file).toFixed(3)}s` },
        {
          type: "input_image",
          image_url: `data:image/jpeg;base64,${Buffer.from(frameRead.value).toString("base64")}`,
          detail: "high",
        },
      );
    }

    let transcriptionText = "";
    if (hasTranscription) {
      const transResult = await fs.files.read(assetId, ".analysis.gpt4otrans.json");
      if (transResult.ok) {
        try {
          const parsed = JSON.parse(
            typeof transResult.value === "string"
              ? transResult.value
              : new TextDecoder().decode(transResult.value)
          ) as { text?: string };
          transcriptionText = parsed.text ?? "";
        } catch {
          // ignore parse errors
        }
      }
    }

    const contextParts: string[] = [];
    if (metadata) {
      const durationStr = typeof metadata.duration === "number" ? `${metadata.duration.toFixed(1)}s` : "unknown";
      contextParts.push(`Video metadata: ${metadata.width}x${metadata.height}, duration ${durationStr}`);
    }
    if (transcriptionText) {
      contextParts.push(`Transcription:\n${transcriptionText}`);
    }
    contextParts.push(`${sampled.length} frames from the video are attached below.`);

    const userContent: OpenAiResponseInputContent[] = [
      { type: "input_text", text: contextParts.join("\n\n") },
      ...frameParts,
    ];

    let analysis: Record<string, unknown> = FALLBACK_ANALYSIS;

    const apiKey = getApiKey("OPENAI_API_KEY");

    if (apiKey) {
      try {
        const responses = buildIntelligenceResponses(apiKey, { timeout: 180_000 });
        const response = await responses(intelligenceRequest({
          instructions: SYSTEM_PROMPT,
          input: [{ role: "user", content: userContent }],
          text: {
            format: {
              type: "json_schema",
              name: "video_analysis",
              schema: ANALYZE_VIDEO_JSON_SCHEMA,
              strict: true,
            },
          },
          max_output_tokens: 4096,
        }), ctx.signal);
        analysis = JSON.parse(firstResponseText(response)) as Record<string, unknown>;
      } catch (e) {
        console.error(`[analyze_video] API failed for ${assetId}:`, e instanceof Error ? e.message : e);
      }
    }

    const jsonString = JSON.stringify(analysis, null, 2);
    await fs.files.write(assetId, ".original.analysis.json", jsonString);
    await queue.enqueue(`semantic-index-${assetId}-analysis-${Date.now()}`, {
      type: "semantic_index",
      assetId,
      bookId,
    } as unknown as Record<string, unknown>);

    // Auto-transcribe trigger (replaces the whitelist-tool gate). Run only if
    // the analysis says there's real dialog, ElevenLabs/Kie is configured, no
    // prior failure or in-progress task, and we haven't already transcribed.
    await maybeEnqueueAutoTranscribe(fs, assetId, assetDir, bookId);

    return { success: true, fallback: analysis === FALLBACK_ANALYSIS, analysis };

    }
    }, { waitForActiveMs: DOWNSTREAM_LEASE_WAIT_MS });
    try {
      await enqueueLazyTimelineRender(fs, bookId, assetId);
    } catch (err) {
      void err;
    }
    return result;
  });
}

async function maybeEnqueueAutoTranscribe(
  fs: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
): Promise<void> {
  if (!getApiKey("ELEVENLABS_API_KEY")) return;

  const manifestResult = await fs.files.manifest(assetId);
  if (!manifestResult.ok) return;
  const manifest = manifestResult.value;
  const fileNames = new Set(manifest.files.map((f) => f.name));

  if (fileNames.has("elevenlabs.json")) return;

  const errorRow = await fs.jobs.failures.read(assetId);
  if (errorRow.ok && errorRow.value !== null) return;

  const dialog = await readAndAssessDialog(fs, assetId, bookId);
  if (!dialog.hasDialog) return;

  const audioFile = findAudioFile(manifest.files, assetId);
  if (!audioFile) return;

  // Stable dedupe key, shared with sync's auto-transcribe: when this trigger
  // races an overlapping sync poll, the queue collapses both onto one job
  // instead of paying for two ElevenLabs transcriptions.
  const jobId = `auto-transcribe-${assetId}`;
  await queue.enqueue(jobId, {
    type: "transcribe",
    audioPath: join(manifest.path, audioFile.name),
    audioFilename: audioFile.name,
    tagAudioEvents: true,
    diarize: true,
    assetId,
    assetDir,
    bookId,
  } as unknown as Record<string, unknown>);
}
