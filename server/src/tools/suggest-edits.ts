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
const SILENCE_MARKER_THRESHOLD_S = 0.5;
const DEAD_AIR_THRESHOLD_S = 1.5;
const TRIM_BUDGET_FRACTION = 0.4;
const CANDIDATE_TOLERANCE_S = 0.3;

const SYSTEM_PROMPT = `You are a senior video editor reviewing a short clip. From the frames, transcript, and metadata you receive, return a strict JSON object suggesting (1) sections to cut and (2) sound effects to add.

TRIM RULES (read carefully — most failures come from breaking these):

1. Dead-air trims (severity "high"):
   - MUST be drawn from the "Silence candidates" list provided in the user message.
   - You MAY shrink a candidate to be more conservative (e.g., keep 0.2-0.4s of natural pause on each side). You MUST NOT expand a candidate or invent one not in the list.
   - You MAY merge two adjacent candidates only if they are < 0.5s apart.
   - If the user message says "no silence candidates", do not suggest any "high" severity trims.

2. Filler-cluster trims (severity "med"):
   - The transcript MUST contain the filler verbatim ("um", "uh", "like", "you know") at the proposed timestamp range.
   - Range MUST be tight around the filler word(s), typically < 1.5s.
   - Do not propose a "med" trim spanning meaningful content.

3. Borderline / minor trims (severity "low"):
   - Reserved for tiny tightening (e.g. a 0.3s repeated word). Use sparingly.

4. Hard limits:
   - Total trim duration (sum of all cut_end - cut_start) MUST be <= the budget given in the user message.
   - Never overlap trim ranges. cut_start < cut_end. Both within [0, duration].
   - Do not cut spoken dialogue that completes a sentence. Do not cut audible chants, laughter, or other deliberate audio events.
   - If unsure, omit. Empty trims is a valid answer.

SFX RULES:
- type: short slug ("whoosh", "impact", "pop", "ding", "ambient_room", "transition_swell").
- Suggest only at clear visual or narrative beats (cuts, reveals, punchlines, scene changes). Cap at 8.
- description: one sentence on what is on screen and why this SFX fits.

OUTPUT:
- Decimal seconds (e.g. 12.4).
- Do not invent content. Use what is visible in the frames or quoted in the transcript.
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

type SilenceCandidate = { start: number; end: number; duration: number };

function extractSilenceCandidates(
  words: ElevenLabsWord[],
  minDurationS: number,
): SilenceCandidate[] {
  const wordEntries = words.filter((w) => w.type === "word");
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
  candidates: SilenceCandidate[],
  trimBudgetS: number,
): string {
  const parts: string[] = [];
  if (meta) {
    const dims = meta.width && meta.height ? `${meta.width}x${meta.height}` : "unknown size";
    const dur = typeof meta.duration === "number" ? `${meta.duration.toFixed(1)}s` : "unknown duration";
    parts.push(`Video metadata: ${dims}, duration ${dur}, hasAudio=${meta.hasAudio ?? "unknown"}`);
  }
  parts.push(`Trim budget: total trim duration must be <= ${trimBudgetS.toFixed(1)}s.`);
  if (transcript.source === "elevenlabs") {
    parts.push(formatCandidatesBlock(candidates));
  } else {
    parts.push("Silence candidates: none (transcript has no word timings; do not propose severity \"high\" trims).");
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

function filterValidTrims(
  trims: z.infer<typeof TrimSchema>[],
  candidates: SilenceCandidate[],
  trimBudgetS: number,
): { kept: z.infer<typeof TrimSchema>[]; dropped: Array<{ trim: z.infer<typeof TrimSchema>; reason: string }> } {
  const dropped: Array<{ trim: z.infer<typeof TrimSchema>; reason: string }> = [];
  const sorted = [...trims].sort((a, b) => a.cut_start - b.cut_start);
  const kept: z.infer<typeof TrimSchema>[] = [];
  let totalDuration = 0;
  let lastEnd = -Infinity;

  for (const t of sorted) {
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

      const candidates = transcript.source === "elevenlabs"
        ? extractSilenceCandidates(transcript.words, DEAD_AIR_THRESHOLD_S)
        : [];
      const duration = typeof meta?.duration === "number" ? meta.duration : 0;
      const trimBudgetS = duration > 0 ? duration * TRIM_BUDGET_FRACTION : Infinity;

      const sampled = sampleFrames(frameNames);
      const framesDir = join(manifest.path, "original_frames");
      const frameParts: OpenAiContentPart[] = [];
      for (const file of sampled) {
        const buf = await fsReadFile(join(framesDir, file));
        frameParts.push(imageBase64Part(buf.toString("base64"), "image/jpeg", "low"));
      }

      const contextString = buildContextString(meta, prior, transcript, sampled.length, candidates, trimBudgetS);
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

      const { kept, dropped } = filterValidTrims(parsed.trims, candidates, trimBudgetS);
      if (dropped.length > 0) {
        console.warn(
          `[suggest_edits] ${assetId}: dropped ${dropped.length} trims:\n`
            + dropped.map((d) => `  - ${d.reason}: ${JSON.stringify(d.trim)}`).join("\n"),
        );
      }

      const final = {
        trims: kept,
        sfx: parsed.sfx,
        summary: parsed.summary,
        based_on: {
          frames: sampled.length,
          transcript_source: transcript.source,
          audio_attached: false,
          silence_candidates: candidates,
          trim_budget_s: Number.isFinite(trimBudgetS) ? trimBudgetS : null,
          dropped_trims: dropped.map((d) => ({ trim: d.trim, reason: d.reason })),
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
