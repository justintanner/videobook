import type { Engine } from "videobook-engine";
import { join } from "node:path";
import type { OpenAiResponseInputContent } from "@apicity/openai";
import { logger } from "../logger.js";
import { registerJobHandler, queue } from "../queue.js";
import { getApiKey } from "../api-key.js";
import { sampleEvenly } from "../frame-utils.js";
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
import { readAssetTranscript } from "../transcript-projection.js";
import { enqueueLazyTimelineRender } from "../lazy-render.js";
import { enqueueAssetTagging } from "./tag-asset.js";
import { frameVocabularyFor, MAX_AUTOMATIC_TAGS } from "../tag-vocabulary.js";
import { DEFAULT_TRANSCRIPT_OPTIONS, elevenLabsTranscriptKey } from "../transcript-components.js";

type AnalyzeVideoPayload = {
  type: "analyze_video";
  assetId: string;
  assetDir: string;
  bookId: string;
  hasTranscription: boolean;
  /**
   * "tagging" means the run exists only to produce evidence for automatic
   * tags. The analysis is cached as usual, but the downstream tails that
   * assume a timeline — auto-transcription and lazy rendering — stay put.
   */
  purpose?: "tagging";
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
- "editorialTags": Up to ${MAX_AUTOMATIC_TAGS} {facet, label} records for grouping footage. Use only visible evidence: people (${frameVocabularyFor("people").join(", ")}), places (${frameVocabularyFor("places").join(", ")}), editing (${frameVocabularyFor("editing").join(", ")}). Return [] when unsupported. Never infer camera movement, sound, interview roles, names or exact geographic locations from these sparse frames. Never convert a negated claim or an incidental object into a tag.
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
    "editorialTags",
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
    editorialTags: {
      type: "array", maxItems: MAX_AUTOMATIC_TAGS,
      items: {
        type: "object", additionalProperties: false, required: ["facet", "label"],
        properties: { facet: { type: "string", enum: ["people", "places", "editing"] }, label: { type: "string" } },
      },
    },
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
  return sampleEvenly(frames, MAX_FRAMES);
}

export function registerAnalyzeVideoJob(engine: Engine): void {
  registerJobHandler("analyze_video", async (payload, ctx) => {
    const {
      assetId, assetDir, bookId, hasTranscription, purpose,
    } = payload as AnalyzeVideoPayload;

    const result = await withLocalLease(engine, assetId, ctx, "analyze", async () => {
    {

    const metaResult = await engine.metadata.artifacts.read<{ width: number; height: number; duration: number }>(assetId, "original"
    );
    const metadata = metaResult.ok ? metaResult.value : null;

    const listResult = await engine.files.listSubdir(assetId, "original_frames");
    const frameFiles = listResult.ok
      ? listResult.value
          .filter((f) => f.endsWith(".jpg"))
          .sort((a, b) => parseFloat(a) - parseFloat(b))
      : [];

    const sampled = sampleFrames(frameFiles);
    if (sampled.length === 0) {
      throw new Error(`No frames to analyze for ${assetId}; process the video before analyzing it`);
    }
    const frameParts: OpenAiResponseInputContent[] = [];
    for (const file of sampled) {
      const frameRead = await engine.files.read(assetId, `original_frames/${file}`);
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

    // Prefers ElevenLabs word cues, falls back to the plain ingest transcript —
    // a manual /transcribe leaves only the former behind.
    let transcriptionText = "";
    if (hasTranscription) {
      const transcript = await readAssetTranscript(engine, assetId);
      if (transcript.kind === "timed" || transcript.kind === "plain") {
        transcriptionText = transcript.text;
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
        logger.error("video-analysis-failed", { assetId, error: e });
      }
    }

    const jsonString = JSON.stringify(analysis, null, 2);
    await engine.files.write(assetId, ".original.analysis.json", jsonString);
    await queue.enqueue(`semantic-index-${assetId}-analysis-${Date.now()}`, {
      type: "semantic_index",
      assetId,
      bookId,
    } as unknown as Record<string, unknown>);

    const usedFallback = analysis === FALLBACK_ANALYSIS;
    // A failed analysis wrote the empty fallback shape; tagging it would fence
    // the asset against the next successful run, so only a real result is
    // offered to the tagger.
    if (!usedFallback) {
      await enqueueAssetTagging(engine, assetId);
    }

    // Auto-transcribe trigger (replaces the whitelist-tool gate). Run only if
    // the analysis says there's real dialog, ElevenLabs/Kie is configured, no
    // prior failure or in-progress task, and we haven't already transcribed.
    if (purpose !== "tagging") {
      await maybeEnqueueAutoTranscribe(engine, assetId, assetDir, bookId);
    }

    return { success: true, fallback: usedFallback, analysis };

    }
    }, { waitForActiveMs: DOWNSTREAM_LEASE_WAIT_MS });
    // Rendering follows analysis for assets on a timeline. A run that exists
    // only to feed the tagger has no timeline behind it, so it renders nothing.
    if (purpose !== "tagging") {
      try {
        await enqueueLazyTimelineRender(engine, bookId, assetId);
      } catch (err) {
        void err;
      }
    }
    return result;
  });
}

async function maybeEnqueueAutoTranscribe(
  engine: Engine,
  assetId: string,
  assetDir: string,
  bookId: string,
): Promise<void> {
  if (!getApiKey("ELEVENLABS_API_KEY")) return;

  const manifestResult = await engine.files.manifest(assetId);
  if (!manifestResult.ok) return;
  const manifest = manifestResult.value;
  const fileNames = new Set(manifest.files.map((f) => f.name));

  if (fileNames.has("elevenlabs.json")) return;

  const errorRow = await engine.jobs.failures.read(assetId);
  if (errorRow.ok && errorRow.value !== null) return;

  const dialog = await readAndAssessDialog(engine, assetId);
  if (!dialog.hasDialog) return;

  const artifact = engine.artifacts.get(assetId);
  if (!artifact.ok) return;

  const audioFile = findAudioFile(manifest.files, artifact.value.kind);
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
    componentKey: elevenLabsTranscriptKey(audioFile.objectHash, DEFAULT_TRANSCRIPT_OPTIONS),
  } as unknown as Record<string, unknown>);
}
