import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { openai, withRetry, withFallback } from "@nakedapi/openai";
import type { OpenAiContentPart } from "@nakedapi/openai";
import { kie } from "@nakedapi/kie";
import { registerJobHandler } from "../queue.js";

type AnalyzeVideoPayload = {
  type: "analyze_video";
  assetId: string;
  assetDir: string;
  projectSlug?: string;
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
};

const SYSTEM_PROMPT = `You are a video analysis expert. Analyze the provided video frames, metadata, and transcription (if available) to produce a comprehensive JSON analysis.

Return a JSON object with these fields:
- "summary": A 2-3 sentence description of the video content
- "scenes": An array of scene descriptions, each with "timestamp" (approximate seconds), "description", and "tags" (array of strings)
- "tags": Top-level tags for the entire video (array of strings)
- "mood": The overall mood/tone of the video
- "subjects": Array of main subjects/people/objects featured
- "actions": Array of key actions or events that occur
- "setting": Description of the environment/location
- "textOnScreen": Array of any visible text in the frames
- "burnedInSubtitles": Detect if subtitles or captions are already burned into the video frames. If detected, return an object with "detected": true, "position": one of "top", "middle", or "bottom" indicating where the text appears, and "confidence": "high", "medium", or "low". If no burned-in subtitles are found, return null. Look for persistent text overlays that appear across multiple frames in a consistent position — these are distinct from occasional on-screen titles or graphics.
- "onScreenGraphic": Detect if there is a watermark, logo, or channel graphic burned into the video. If detected, return an object with "detected": true, "position": one of "top-left", "top-right", "bottom-left", or "bottom-right" indicating the corner where it appears, "description": a brief description of what it is (e.g. "TikTok logo", "channel watermark"), and "confidence": "high", "medium", or "low". If none found, return null.
- "recommendedSubtitlePosition": Based on what is already on screen, recommend the best position ("top", "middle", or "bottom") for adding subtitle overlays that will not conflict with any detected burned-in subtitles or on-screen graphics. If burned-in subtitles are at the bottom, recommend "top". If nothing is detected, default to "bottom".
- "recommendedOsgPosition": Based on what is already on screen, recommend the best corner ("top-left", "top-right", "bottom-left", or "bottom-right") for placing an overlay graphic that will not conflict with any detected on-screen graphics. If nothing is detected, default to "top-right".`;

function sampleFrames(frames: string[]): string[] {
  if (frames.length <= MAX_FRAMES) return frames;
  const step = (frames.length - 1) / (MAX_FRAMES - 1);
  return Array.from({ length: MAX_FRAMES }, (_, i) =>
    frames[Math.round(i * step)]
  );
}

export function registerAnalyzeVideoJob(fs: ClipfirstFs): void {
  registerJobHandler("analyze_video", async (payload) => {
    const {
      assetId, assetDir, projectSlug, hasTranscription,
    } = payload as AnalyzeVideoPayload;

    const metaResult = await fs.readMetadata<{ width: number; height: number; duration: number }>(
      assetId, "original", projectSlug
    );
    const metadata = metaResult.ok ? metaResult.value : null;

    const framesDir = join(assetDir, "original_frames");
    let frameFiles: string[] = [];
    try {
      const entries = await readdir(framesDir);
      frameFiles = entries
        .filter((f) => f.endsWith(".jpg"))
        .sort((a, b) => parseFloat(a) - parseFloat(b));
    } catch {
      // no frames directory
    }

    const sampled = sampleFrames(frameFiles);
    const frameParts: OpenAiContentPart[] = [];
    for (const file of sampled) {
      const buf = await readFile(join(framesDir, file));
      const dataUri = `data:image/jpeg;base64,${buf.toString("base64")}`;
      frameParts.push({
        type: "image_url",
        image_url: { url: dataUri, detail: "low" },
      });
    }

    let transcriptionText = "";
    if (hasTranscription) {
      const transResult = await fs.readFile(assetId, ".analysis.gpt4otrans.json", projectSlug);
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
      contextParts.push(`Video metadata: ${metadata.width}x${metadata.height}, duration ${metadata.duration.toFixed(1)}s`);
    }
    if (transcriptionText) {
      contextParts.push(`Transcription:\n${transcriptionText}`);
    }
    contextParts.push(`${sampled.length} frames from the video are attached below.`);

    const userContent: OpenAiContentPart[] = [
      { type: "text", text: contextParts.join("\n\n") },
      ...frameParts,
    ];

    let analysis: Record<string, unknown> = FALLBACK_ANALYSIS;

    const openaiKey = process.env.OPENAI_API_KEY;
    const kieKey = process.env.KIE_API_KEY;

    const providers: Array<(req: Record<string, unknown>, signal?: AbortSignal) => Promise<{ content: string }>> = [];
    if (openaiKey) {
      const p = openai({ apiKey: openaiKey, timeout: 180_000 });
      providers.push(withRetry(p.v1.chat.completions, { retries: 2, baseMs: 500 }));
    }
    if (kieKey) {
      const p = kie({ apiKey: kieKey, timeout: 180_000 });
      providers.push(withRetry(p.chat.gpt52.v1.chat.completions, { retries: 2, baseMs: 500 }));
    }

    if (providers.length > 0) {
      try {
        const chat = providers.length > 1
          ? withFallback(providers)
          : providers[0];
        const result = await chat({
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          response_format: { type: "json_object" },
          temperature: 0.3,
          max_completion_tokens: 4096,
          max_tokens: 4096,
        });
        analysis = JSON.parse(result.content);
      } catch {
        // all providers failed — use empty fallback
      }
    }

    const jsonString = JSON.stringify(analysis, null, 2);
    await fs.writeFile(assetId, ".original.analysis.json", jsonString, projectSlug);

    return { success: true, fallback: analysis === FALLBACK_ANALYSIS, analysis };
  });
}
