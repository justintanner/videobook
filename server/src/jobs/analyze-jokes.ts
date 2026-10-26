import type { Engine } from "videobook-engine";
import { z } from "zod";
import { registerJobHandler } from "../queue.js";
import { getApiKey } from "../api-key.js";
import {
  INTELLIGENCE_MODEL,
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";
import { withLocalLease } from "./_lease.js";
import { runSidecarAnalysis } from "../analysis-sidecars.js";
import { JOKES, jokesRecord } from "../suggestion-components.js";
import type { ElevenLabs, ElevenLabsWord } from "../tools/_suggest-shared.js";

type AnalyzeJokesPayload = {
  type: "analyze_jokes";
  assetId: string;
  assetDir: string;
  bookId: string;
  force?: boolean;
};

const JOKE_TYPES = [
  "pun",
  "self_deprecating",
  "observational",
  "absurdist",
  "callback",
  "sarcasm",
  "wordplay",
  "misdirection",
  "hyperbole",
  "irony",
  "anti_humor",
  "other",
] as const;

const SYSTEM_PROMPT = `You are a comedy writer analyzing a transcript of a stand-up or monologue clip. Identify the distinct jokes in the bit.

For each joke:
- Classify its primary type, choosing exactly one value from the allowed set.
- Quote the joke verbatim from the transcript (the punchline plus the minimal setup needed to understand it).
- Give the start and end time in seconds, drawn from the word-timing table.
- Explain in one sentence why it works.

RULES:
- Do not invent jokes. Only use lines present in the transcript.
- start < end, and both must fall within the clip's word timings.
- Prefer a few clear, well-formed jokes over an exhaustive list.
- Output JSON only.`;

const JOKES_JSON_SCHEMA = {
  type: "object",
  required: ["jokes", "summary"],
  additionalProperties: false,
  properties: {
    jokes: {
      type: "array",
      items: {
        type: "object",
        required: ["type", "text", "start", "end", "why"],
        additionalProperties: false,
        properties: {
          type: { type: "string", enum: JOKE_TYPES },
          text: { type: "string" },
          start: { type: "number" },
          end: { type: "number" },
          why: { type: "string" },
        },
      },
    },
    summary: { type: "string" },
  },
} as const;

const JokeSchema = z.object({
  type: z.enum(JOKE_TYPES),
  text: z.string(),
  start: z.number(),
  end: z.number(),
  why: z.string(),
});

const ModelOutputSchema = z.object({
  jokes: z.array(JokeSchema),
  summary: z.string(),
});

type ModelOutput = z.infer<typeof ModelOutputSchema>;

function spokenWords(words: ElevenLabsWord[]): ElevenLabsWord[] {
  return words.filter((w) => w.type === "word");
}

function buildJokesContext(eleven: ElevenLabs): string {
  const table = spokenWords(eleven.words)
    .map((w) => `${w.start.toFixed(2)}-${w.end.toFixed(2)} ${w.text.trim()}`)
    .join("\n");
  return [
    "TRANSCRIPT:",
    eleven.text,
    "",
    "WORD TIMINGS (start-end seconds, one word per line):",
    table,
  ].join("\n");
}

async function analyzeJokes(engine: Engine, assetId: string, signal: AbortSignal) {
  const apiKey = getApiKey("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");

  const read = await engine.files.read(assetId, "elevenlabs.json");
  if (!read.ok) {
    throw new Error(`No ElevenLabs transcript found for ${assetId} — run /transcribe @${assetId} first.`);
  }

  let eleven: ElevenLabs;
  try {
    eleven = JSON.parse(read.value.toString()) as ElevenLabs;
  } catch {
    throw new Error(`elevenlabs.json for ${assetId} is not valid JSON`);
  }
  if (!Array.isArray(eleven.words) || spokenWords(eleven.words).length === 0) {
    throw new Error(`No ElevenLabs transcript found for ${assetId} — run /transcribe @${assetId} first.`);
  }

  const responses = buildIntelligenceResponses(apiKey, { timeout: 240_000 });
  const result = await responses(intelligenceRequest({
    instructions: SYSTEM_PROMPT,
    input: [{ role: "user", content: buildJokesContext(eleven) }],
    text: {
      format: {
        type: "json_schema",
        name: "analyze_jokes_result",
        schema: JOKES_JSON_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 4096,
  }), signal);
  const outputText = firstResponseText(result);

  let parsed: ModelOutput;
  try {
    parsed = ModelOutputSchema.parse(JSON.parse(outputText));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Model output failed schema validation: ${msg}`);
  }

  return {
    jokes: parsed.jokes,
    summary: parsed.summary,
    based_on: {
      transcript_source: "elevenlabs" as const,
      word_count: spokenWords(eleven.words).length,
    },
    model: INTELLIGENCE_MODEL,
    asset_id: assetId,
  };
}

export function registerAnalyzeJokesJob(engine: Engine): void {
  registerJobHandler("analyze_jokes", async (payload, ctx) => {
    const { assetId, force } = payload as AnalyzeJokesPayload;

    return withLocalLease(engine, assetId, ctx, "analyze", async () => {
      const outcome = await runSidecarAnalysis(engine, JOKES, {
        force: force === true,
        record: () => jokesRecord(engine, assetId),
        compute: () => analyzeJokes(engine, assetId, ctx.signal),
        provenance: { analyzer: "analyze-jokes", provider: "openai", model: INTELLIGENCE_MODEL },
      });
      if (outcome.cached) return { success: true, cached: true };
      return { success: true, jokes: outcome.value.jokes.length };
    });
  });
}
