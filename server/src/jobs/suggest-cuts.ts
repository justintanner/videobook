import type { Engine } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import type { KieGeminiPart } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { getApiKey } from "../api-key.js";
import { withLocalLease } from "./_lease.js";
import {
  MODEL,
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
import { callGeminiFlashJson, geminiImageBase64Part, geminiTextPart } from "../kie-gemini.js";

type SuggestCutsPayload = {
  type: "suggest_cuts";
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

const SYSTEM_PROMPT_CUTS = `You are a senior video editor reviewing a short clip. From the frames, transcript, and metadata you receive, return a strict JSON object suggesting sections to cut.

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

export function registerSuggestCutsJob(fs: Engine): void {
  registerJobHandler("suggest_cuts", async (payload, ctx) => {
    const { assetId, projectSlug } = payload as SuggestCutsPayload;

    return withLocalLease(fs, projectSlug, assetId, ctx, "analyze", async () => {
      const apiKey = getApiKey("KIE_API_KEY");
      if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

      const loaded = await loadAssetForAnalysis(fs, assetId, projectSlug);
      if (!loaded.ok) throw new Error(loaded.error.message);
      const { framesDir, frameNames, transcript, meta, prior } = loaded.value;

      const candidates = transcript.source === "elevenlabs"
        ? extractSilenceCandidates(transcript.words, DEAD_AIR_THRESHOLD_S)
        : [];
      const duration = typeof meta?.duration === "number" ? meta.duration : 0;
      const trimBudgetS = duration > 0 ? duration * TRIM_BUDGET_FRACTION : Infinity;

      const sampled = sampleFrames(frameNames);
      const frameParts: KieGeminiPart[] = [];
      for (const file of sampled) {
        const buf = await fsReadFile(join(framesDir, file));
        frameParts.push(geminiImageBase64Part(buf.toString("base64"), "image/jpeg"));
      }

      const contextString = buildCutsContext(meta, prior, transcript, sampled.length, candidates, trimBudgetS);
      const userContent: KieGeminiPart[] = [
        geminiTextPart(contextString),
        ...frameParts,
      ];

      const outputText = await callGeminiFlashJson({
        apiKey,
        parts: [
          geminiTextPart(`Instructions:\n${SYSTEM_PROMPT_CUTS}`),
          ...userContent,
        ],
        temperature: 0.3,
        maxOutputTokens: 4096,
        responseSchema: SUGGEST_CUTS_JSON_SCHEMA as unknown as Record<string, unknown>,
      });

      let parsed: { trims: Trim[]; summary: string };
      try {
        parsed = ModelOutputSchema.parse(JSON.parse(outputText));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Model output failed schema validation: ${msg}`);
      }

      const { kept, dropped } = filterValidTrims(parsed.trims, candidates, trimBudgetS);
      if (dropped.length > 0) {
        console.warn(
          `[suggest_cuts] ${assetId}: dropped ${dropped.length} trims:\n`
            + dropped.map((d) => `  - ${d.reason}: ${JSON.stringify(d.trim)}`).join("\n"),
        );
      }

      const final = {
        trims: kept,
        summary: parsed.summary,
        based_on: {
          frames: sampled.length,
          transcript_source: transcript.source,
          silence_candidates: candidates,
          trim_budget_s: Number.isFinite(trimBudgetS) ? trimBudgetS : null,
          dropped_trims: dropped.map((d) => ({ trim: d.trim, reason: d.reason })),
        },
        model: MODEL,
        asset_id: assetId,
      };

      const writeResult = await fs.files.write(
        assetId,
        ".suggest-cuts.json",
        JSON.stringify(final, null, 2),
        projectSlug,
      );
      if (!writeResult.ok) {
        throw new Error(`Suggestions generated but failed to persist: ${writeResult.error.message}`);
      }

      return { success: true, trims: kept.length, dropped: dropped.length };
    });
  });
}
