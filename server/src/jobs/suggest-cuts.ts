import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { OpenAiResponseInputContent } from "@apicity/openai";
import { logger } from "../logger.js";
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
import { SUGGESTED_CUTS, suggestionRecord } from "../suggestion-components.js";
import {
  TRIM_BUDGET_FRACTION,
  DEAD_AIR_THRESHOLD_S,
  TrimSchema,
  buildCutsContext,
  extractSilenceCandidates,
  filterValidTrims,
  loadAssetForAnalysis,
  sampleFrames,
  type Trim,
} from "../tools/_suggest-shared.js";

type SuggestCutsPayload = {
  type: "suggest_cuts";
  assetId: string;
  assetDir: string;
  bookId: string;
  instructions?: string;
  force?: boolean;
};

const SYSTEM_PROMPT_CUTS = `You are a senior video editor reviewing a short clip. From the timestamped frames, optional transcript, and metadata you receive, return a strict JSON object suggesting sections to cut. Follow the user's editing request when provided.

TRIM RULES (read carefully — most failures come from breaking these):

1. Dead-air trims (severity "high"):
   - MUST be drawn from the "Silence candidates" list provided in the user message.
   - You MAY shrink a candidate to be more conservative (e.g., keep 0.2-0.4s of natural pause on each side). You MUST NOT expand a candidate or invent one not in the list.
   - You MAY merge two adjacent candidates only if they are < 0.5s apart.
   - If the user message says "no silence candidates", do not suggest any "high" severity trims.

2. Filler-cluster trims (severity "med"):
   - Require a word-timed transcript. Without word timings, do not suggest any "med" trims.
   - The transcript MUST contain the filler verbatim ("um", "uh", "like", "you know") at the proposed timestamp range.
   - Range MUST be tight around the filler word(s), typically < 1.5s.
   - Do not propose a "med" trim spanning meaningful content.

3. Visual pacing / minor trims (severity "low"):
   - Use timestamped frames to identify clearly redundant visual holds or awkward lead-ins and tails. Explain the visible evidence and keep the ranges conservative.
   - Without a transcript, only these visually supported "low" trims are allowed. Missing transcription is not evidence of silence or absence of dialogue. State in the summary that dialogue and audio timing were not assessed.
   - Sparse frames do not prove what happens between them. Do not invent precise action boundaries; omit uncertain cuts.

4. Hard limits:
   - Total trim duration (sum of all cut_end - cut_start) MUST be <= the budget given in the user message.
   - Never overlap trim ranges. cut_start < cut_end. Both within [0, duration].
   - Do not cut spoken dialogue that completes a sentence. Do not cut audible chants, laughter, or other deliberate audio events.
   - If unsure, omit. Empty trims is a valid answer.

OUTPUT:
- Decimal seconds (e.g. 12.4).
- Do not invent content. Use what is visible in the frames or quoted in the transcript.
- Prefer fewer high-confidence suggestions over noisy lists.
- Output JSON only.`;

const SUGGEST_CUTS_JSON_SCHEMA = {
  type: "object",
  required: ["trims", "summary"],
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
    summary: { type: "string" },
  },
} as const;

const ModelOutputSchema = z.object({
  trims: z.array(TrimSchema),
  summary: z.string(),
});

async function suggestCuts(engine: Engine, assetId: string, instructions: string | undefined, signal: AbortSignal) {
  const apiKey = getApiKey("OPENAI_API_KEY");
  if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");

  const loaded = await loadAssetForAnalysis(engine, assetId, { requireTranscript: false });
  if (!loaded.ok) throw new Error(loaded.error.message);
  const { frameNames, transcript, meta, prior } = loaded.value;

  const candidates = transcript.source === "elevenlabs"
    ? extractSilenceCandidates(transcript.words, DEAD_AIR_THRESHOLD_S)
    : [];
  const duration = typeof meta?.duration === "number" && Number.isFinite(meta.duration) && meta.duration > 0
    ? meta.duration : null;
  const trimBudgetS = duration !== null ? duration * TRIM_BUDGET_FRACTION : Infinity;

  const sampled = sampleFrames(frameNames);
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

  const contextString = buildCutsContext(meta, prior, transcript, sampled.length, candidates, trimBudgetS, instructions);
  const userContent: OpenAiResponseInputContent[] = [
    { type: "input_text", text: contextString },
    ...frameParts,
  ];

  const responses = buildIntelligenceResponses(apiKey);
  const response = await responses(intelligenceRequest({
    instructions: SYSTEM_PROMPT_CUTS,
    input: [{ role: "user", content: userContent }],
    text: {
      format: {
        type: "json_schema",
        name: "suggested_cuts",
        schema: SUGGEST_CUTS_JSON_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 4096,
  }), signal);
  const outputText = firstResponseText(response);

  let parsed: { trims: Trim[]; summary: string };
  try {
    parsed = ModelOutputSchema.parse(JSON.parse(outputText));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Model output failed schema validation: ${msg}`);
  }

  const { kept, dropped } = filterValidTrims(parsed.trims, candidates, trimBudgetS, {
    duration, transcriptSource: transcript.source,
  });
  if (dropped.length > 0) {
    logger.warn("suggest-cuts-dropped", { assetId, count: dropped.length });
  }

  return {
    trims: kept,
    summary: parsed.summary,
    based_on: {
      frames: sampled.length,
      transcript_source: transcript.source,
      silence_candidates: candidates,
      trim_budget_s: Number.isFinite(trimBudgetS) ? trimBudgetS : null,
      dropped_trims: dropped.map((d) => ({ trim: d.trim, reason: d.reason })),
    },
    model: INTELLIGENCE_MODEL,
    asset_id: assetId,
  };
}

export function registerSuggestCutsJob(engine: Engine): void {
  registerJobHandler("suggest_cuts", async (payload, ctx) => {
    const { assetId, instructions, force } = payload as SuggestCutsPayload;

    return withLocalLease(engine, assetId, ctx, "analyze", async () => {
      const outcome = await runSidecarAnalysis(engine, SUGGESTED_CUTS, {
        force: force === true,
        record: () => suggestionRecord(engine, SUGGESTED_CUTS, assetId, { instructions: instructions?.trim() || null }),
        compute: () => suggestCuts(engine, assetId, instructions, ctx.signal),
        provenance: { analyzer: "suggest-cuts", provider: "openai", model: INTELLIGENCE_MODEL },
      });
      if (outcome.cached) return { success: true, cached: true };
      return { success: true, trims: outcome.value.trims.length, dropped: outcome.value.based_on.dropped_trims.length };
    });
  });
}
