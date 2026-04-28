import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ClipfirstFs } from "clipfirst-fs";
import { z } from "zod";
import { join } from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import { openai, withRetry, textPart, imageBase64Part, firstContent } from "@apicity/openai";
import type { OpenAiContentPart } from "@apicity/openai";
import { findVideoFile } from "../media-files.js";
import type { ToolDef } from "./tool-def.js";

const MODEL = "gpt-5.4";
const MAX_FRAMES = 15;
const SILENCE_THRESHOLD_S = 0.5;

const SYSTEM_PROMPT = `You are a senior video editor reviewing a short clip. From the frames, transcript, audio, and metadata you receive, return a strict JSON object suggesting (1) sections to cut and (2) sound effects to add.

trims:
- Cover dead air / silences > 1.5s, filler clusters ("um", "uh", "like", "you know"), awkward false starts or repeated takes, off-topic tangents, visibly weird segments (camera bump, accidental reframe).
- severity: "high" for dead air or broken takes; "med" for filler clusters; "low" for borderline.
- Never overlap trim ranges. cut_start < cut_end. Both >= 0 and <= duration.
- Do not cut mid-sentence unless severity is "high".

sfx:
- type: short slug ("whoosh", "impact", "pop", "ding", "ambient_room", "transition_swell").
- Suggest only at clear visual or narrative beats. Cap at 8.
- description: one sentence on what is on screen and why this SFX fits.

Rules:
- Decimal seconds (e.g. 12.4).
- Do not invent content. Use what is visible/audible.
- Prefer fewer high-confidence suggestions over noisy lists.
- Output JSON only.`;

const SUGGEST_EDITS_JSON_SCHEMA = {
  type: "object",
  required: ["trims", "sfx", "summary"],
  additionalProperties: false,
  properties: {
    trims: {
      type: "array",
      items: {
        type: "object",
        required: ["cut_start", "cut_end", "reason", "severity"],
        additionalProperties: false,
        properties: {
          cut_start: { type: "number" },
          cut_end: { type: "number" },
          reason: { type: "string" },
          severity: { type: "string", enum: ["low", "med", "high"] },
        },
      },
    },
    sfx: {
      type: "array",
      items: {
        type: "object",
        required: ["timestamp", "type", "description"],
        additionalProperties: false,
        properties: {
          timestamp: { type: "number" },
          type: { type: "string" },
          description: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
} as const;

const TrimSchema = z.object({
  cut_start: z.number().min(0),
  cut_end: z.number().min(0),
  reason: z.string(),
  severity: z.enum(["low", "med", "high"]),
});

const SfxSchema = z.object({
  timestamp: z.number().min(0),
  type: z.string(),
  description: z.string(),
});

const ModelOutputSchema = z.object({
  trims: z.array(TrimSchema),
  sfx: z.array(SfxSchema),
  summary: z.string(),
});

type ElevenLabsWord = {
  text: string;
  start: number;
  end: number;
  type: "word" | "spacing";
  speaker_id?: string;
};

type ElevenLabs = {
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
  | { source: "gpt4otrans"; text: string };

function sampleFrames(frames: string[]): string[] {
  if (frames.length <= MAX_FRAMES) return frames;
  const step = (frames.length - 1) / (MAX_FRAMES - 1);
  return Array.from({ length: MAX_FRAMES }, (_, i) =>
    frames[Math.round(i * step)]
  );
}

function decodeBuffer(buf: Buffer | string): string {
  if (typeof buf === "string") return buf;
  return new TextDecoder().decode(buf);
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
    lines.push(`[t=${turnStart.toFixed(2)} spk=${spk}] ${currentTurn.join(" ")}`);
    currentTurn = [];
  };

  for (const w of wordEntries) {
    if (prevEnd !== null) {
      const gap = w.start - prevEnd;
      if (gap > SILENCE_THRESHOLD_S) {
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
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
): Promise<TranscriptResult | null> {
  const elevenRead = await fs.readFile(assetId, "elevenlabs.json", projectSlug);
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
  const gptRead = await fs.readFile(assetId, ".analysis.gpt4otrans.json", projectSlug);
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
  fs: ClipfirstFs,
  assetId: string,
  projectSlug: string,
): Promise<PriorAnalysis | null> {
  const read = await fs.readFile(assetId, ".original.analysis.json", projectSlug);
  if (!read.ok) return null;
  try {
    return JSON.parse(decodeBuffer(read.value)) as PriorAnalysis;
  } catch {
    return null;
  }
}

function buildContextString(
  meta: OriginalMeta | null,
  prior: PriorAnalysis | null,
  transcript: TranscriptResult,
  frameCount: number,
): string {
  const parts: string[] = [];
  if (meta) {
    const dims = meta.width && meta.height ? `${meta.width}x${meta.height}` : "unknown size";
    const dur = typeof meta.duration === "number" ? `${meta.duration.toFixed(1)}s` : "unknown duration";
    parts.push(`Video metadata: ${dims}, duration ${dur}, hasAudio=${meta.hasAudio ?? "unknown"}`);
  }
  if (prior) {
    const scenes = (prior.scenes ?? [])
      .map((s) => `t=${(s.timestamp ?? 0).toFixed(1)}s: ${s.description ?? ""}`)
      .join("; ");
    parts.push(
      `Prior analysis — summary: ${prior.summary ?? "n/a"}; mood: ${prior.mood ?? "n/a"}; scenes: ${scenes || "n/a"}`,
    );
  }
  if (transcript.source === "elevenlabs") {
    parts.push(`Transcript (word-level, with silence markers):\n${condenseElevenLabsWords(transcript.words)}`);
  } else {
    parts.push(`Transcript (no word timings):\n${transcript.text}`);
  }
  parts.push(`${frameCount} frames at low detail follow.`);
  return parts.join("\n\n");
}

export function suggestEditsDef(fs: ClipfirstFs): ToolDef {
  return {
    name: "suggest_edits",
    description:
      "Analyze a video asset (frames + transcript + metadata) and return structured suggestions: " +
      "trims (dead air, fillers, awkward sections) and SFX placements (timestamps + types). " +
      "Persists to .suggest-edits.json. Requires a transcript — run /transcribe first if missing.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid-* or @vid-slug)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: "OPENAI_API_KEY environment variable is not set" }],
        };
      }

      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const assetId = asset_id.replace(/^@/, "");

      const manifestResult = await fs.getManifest(assetId, project_slug, { includeDotfiles: true });
      if (!manifestResult.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: manifestResult.error.message }],
        };
      }
      const manifest = manifestResult.value;

      const videoFile = findVideoFile(manifest.files);
      if (!videoFile) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `No video file found in asset ${assetId}` }],
        };
      }

      const frameNames = (manifest.directories?.["original_frames"] ?? [])
        .filter((f) => f.endsWith(".jpg"))
        .sort((a, b) => parseFloat(a) - parseFloat(b));
      if (frameNames.length === 0) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `${assetId} has no frames in original_frames/; run /process-video first.`,
          }],
        };
      }

      const transcript = await loadTranscript(fs, assetId, project_slug);
      if (!transcript) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `No transcript found for ${assetId}. Run /transcribe @${assetId} first.`,
          }],
        };
      }

      const metaResult = await fs.readMetadata<OriginalMeta>(assetId, "original", project_slug);
      const meta = metaResult.ok ? metaResult.value : null;
      const prior = await loadPriorAnalysis(fs, assetId, project_slug);

      const sampled = sampleFrames(frameNames);
      const framesDir = join(manifest.path, "original_frames");
      const frameParts: OpenAiContentPart[] = [];
      for (const file of sampled) {
        const buf = await fsReadFile(join(framesDir, file));
        frameParts.push(imageBase64Part(buf.toString("base64"), "image/jpeg", "low"));
      }

      const contextString = buildContextString(meta, prior, transcript, sampled.length);
      const userContent: OpenAiContentPart[] = [
        textPart(contextString),
        ...frameParts,
      ];

      const provider = openai({ apiKey, timeout: 240_000 });
      const call = withRetry(provider.post.v1.chat.completions, { retries: 2, baseMs: 500 });

      let outputText: string;
      try {
        const result = await call({
          model: MODEL,
          stream: false,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "suggest_edits_result",
              schema: SUGGEST_EDITS_JSON_SCHEMA as unknown as Record<string, unknown>,
              strict: true,
            },
          },
          temperature: 0.3,
          max_completion_tokens: 4096,
        });
        outputText = firstContent(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `OpenAI call failed: ${msg}` }],
        };
      }

      let parsed: z.infer<typeof ModelOutputSchema>;
      try {
        const raw = JSON.parse(outputText);
        parsed = ModelOutputSchema.parse(raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: `Model output failed schema validation: ${msg}` }],
        };
      }

      const final = {
        trims: parsed.trims,
        sfx: parsed.sfx,
        summary: parsed.summary,
        based_on: {
          frames: sampled.length,
          transcript_source: transcript.source,
          audio_attached: false,
        },
        model: MODEL,
        asset_id: assetId,
      };

      const writeResult = await fs.writeFile(
        assetId,
        ".suggest-edits.json",
        JSON.stringify(final, null, 2),
        project_slug,
      );
      if (!writeResult.ok) {
        return {
          isError: true as const,
          content: [{
            type: "text" as const,
            text: `Suggestions generated but failed to persist: ${writeResult.error.message}`,
          }],
        };
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(final) }],
      };
    },
  };
}

export function registerSuggestEditsTool(server: McpServer, fs: ClipfirstFs): void {
  const def = suggestEditsDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
