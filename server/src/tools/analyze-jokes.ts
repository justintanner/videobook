import type { VideocityFs } from "videocity-engine";
import { z } from "zod";
import { createOpenAi, withRetry, textPart, firstContent } from "@apicity/openai";
import type { OpenAiContentPart } from "@apicity/openai";
import type { ToolDef, ToolResult } from "./tool-def.js";
import type { ElevenLabs, ElevenLabsWord } from "./_suggest-shared.js";

const JOKES_MODEL = "gpt-5.5";

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

function error(text: string): ToolResult {
  return { isError: true as const, content: [{ type: "text" as const, text }] };
}

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

export function analyzeJokesDef(fs: VideocityFs): ToolDef {
  return {
    name: "analyze_jokes",
    description:
      "Analyze a clip's ElevenLabs transcript and identify the jokes in the bit, classified by type " +
      "(pun, self-deprecating, observational, etc.). Each joke includes the verbatim text, start/end " +
      "timestamps, and a one-line note on why it works. Persists to .analyze-jokes.json. " +
      "Requires an ElevenLabs transcript — run /transcribe first if missing.",
    schema: {
      asset_id: z.string().describe("Video asset ID (vid-* or @vid-slug)"),
      project_slug: z.string().describe("Project slug"),
    },
    handler: async (args) => {
      const apiKey = process.env.OPENAI_API_KEY;
      if (!apiKey) {
        return error("OPENAI_API_KEY environment variable is not set");
      }

      const { asset_id, project_slug } = args as { asset_id: string; project_slug: string };
      const assetId = asset_id.replace(/^@/, "");

      const read = await fs.readFile(assetId, "elevenlabs.json", project_slug);
      if (!read.ok) {
        return error(
          `No ElevenLabs transcript found for ${assetId} — run /transcribe @${assetId} first.`,
        );
      }

      let eleven: ElevenLabs;
      try {
        eleven = JSON.parse(read.value.toString()) as ElevenLabs;
      } catch {
        return error(`elevenlabs.json for ${assetId} is not valid JSON`);
      }
      if (!Array.isArray(eleven.words) || spokenWords(eleven.words).length === 0) {
        return error(
          `No ElevenLabs transcript found for ${assetId} — run /transcribe @${assetId} first.`,
        );
      }

      const userContent: OpenAiContentPart[] = [textPart(buildJokesContext(eleven))];

      const provider = createOpenAi({ apiKey, timeout: 240_000 });
      const call = withRetry(provider.post.v1.chat.completions, { retries: 2, baseMs: 500 });

      let outputText: string;
      try {
        const result = await call({
          model: JOKES_MODEL,
          stream: false,
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "analyze_jokes_result",
              schema: JOKES_JSON_SCHEMA as unknown as Record<string, unknown>,
              strict: true,
            },
          },
          max_completion_tokens: 4096,
        });
        outputText = firstContent(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return error(`OpenAI call failed: ${msg}`);
      }

      let parsed: ModelOutput;
      try {
        parsed = ModelOutputSchema.parse(JSON.parse(outputText));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return error(`Model output failed schema validation: ${msg}`);
      }

      const final = {
        jokes: parsed.jokes,
        summary: parsed.summary,
        based_on: {
          transcript_source: "elevenlabs" as const,
          word_count: spokenWords(eleven.words).length,
        },
        model: JOKES_MODEL,
        asset_id: assetId,
      };

      const writeResult = await fs.writeFile(
        assetId,
        ".analyze-jokes.json",
        JSON.stringify(final, null, 2),
        project_slug,
      );
      if (!writeResult.ok) {
        return error(`Jokes analyzed but failed to persist: ${writeResult.error.message}`);
      }

      return {
        content: [{ type: "text" as const, text: JSON.stringify(final) }],
      };
    },
  };
}
