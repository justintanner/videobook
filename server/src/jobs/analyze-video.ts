import type { ClipfirstFs } from "clipfirst-fs";
import { join } from "node:path";
import { readdir, readFile } from "node:fs/promises";
import { openai } from "@nakedapi/openai";
import type { OpenAiContentPart } from "@nakedapi/openai";
import { registerJobHandler } from "../queue.js";

type AnalyzeVideoPayload = {
  type: "analyze_video";
  assetId: string;
  assetDir: string;
  projectSlug?: string;
  hasTranscription: boolean;
};

const MAX_FRAMES = 15;

const SYSTEM_PROMPT = `You are a video analysis expert. Analyze the provided video frames, metadata, and transcription (if available) to produce a comprehensive JSON analysis.

Return a JSON object with these fields:
- "summary": A 2-3 sentence description of the video content
- "scenes": An array of scene descriptions, each with "timestamp" (approximate seconds), "description", and "tags" (array of strings)
- "tags": Top-level tags for the entire video (array of strings)
- "mood": The overall mood/tone of the video
- "subjects": Array of main subjects/people/objects featured
- "actions": Array of key actions or events that occur
- "setting": Description of the environment/location
- "textOnScreen": Array of any visible text in the frames`;

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

    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return { success: false, reason: "OPENAI_API_KEY not set" };

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

    const provider = openai({ apiKey, timeout: 180_000 });
    const result = await provider.chat({
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0.3,
      max_completion_tokens: 4096,
    });

    const analysis = JSON.parse(result.content);
    const jsonString = JSON.stringify(analysis, null, 2);
    await fs.writeFile(assetId, ".original.analysis.json", jsonString, projectSlug);

    return { success: true, analysis };
  });
}
