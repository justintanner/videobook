import type { VideocityFs } from "videobook-engine";
import { z } from "zod";
import { join } from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import type { KieGeminiPart } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { getApiKey } from "../api-key.js";
import { withLocalLease } from "./_lease.js";
import {
  MODEL,
  SfxSchema,
  buildSfxContext,
  loadAssetForAnalysis,
  sampleFrames,
  type Sfx,
} from "../tools/_suggest-shared.js";
import { callGeminiFlashJson, geminiImageBase64Part, geminiTextPart } from "../kie-gemini.js";

const MAX_SFX = 8;
const TIMESTAMP_END_BUFFER_S = 0.05;

type SuggestSfxPayload = {
  type: "suggest_sfx";
  assetId: string;
  assetDir: string;
  projectSlug: string;
};

const SYSTEM_PROMPT_SFX = `You are a senior video editor reviewing a short clip. From the frames, transcript, and metadata you receive, return a strict JSON object suggesting sound effects to add.

SFX RULES:
- type: short slug ("whoosh", "impact", "pop", "ding", "ambient_room", "transition_swell").
- Suggest only at clear visual or narrative beats (cuts, reveals, punchlines, scene changes). Cap at ${MAX_SFX}.
- description: one sentence on what is on screen and why this SFX fits.

OUTPUT:
- Decimal seconds (e.g. 12.4).
- Do not invent content. Use what is visible in the frames or quoted in the transcript.
- Prefer fewer high-confidence suggestions over noisy lists.
- Output JSON only, max ${MAX_SFX} entries.`;

const SUGGEST_SFX_JSON_SCHEMA = {
  type: "object",
  required: ["sfx", "summary"],
  additionalProperties: false,
  properties: {
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

const ModelOutputSchema = z.object({
  sfx: z.array(SfxSchema),
  summary: z.string(),
});

export function registerSuggestSfxJob(fs: VideocityFs): void {
  registerJobHandler("suggest_sfx", async (payload, ctx) => {
    const { assetId, projectSlug } = payload as SuggestSfxPayload;

    return withLocalLease(fs, projectSlug, assetId, ctx, "analyze", async () => {
      const apiKey = getApiKey("KIE_API_KEY");
      if (!apiKey) throw new Error("KIE_API_KEY environment variable is not set");

      const loaded = await loadAssetForAnalysis(fs, assetId, projectSlug);
      if (!loaded.ok) throw new Error(loaded.error.message);
      const { framesDir, frameNames, transcript, meta, prior } = loaded.value;

      const sampled = sampleFrames(frameNames);
      const frameParts: KieGeminiPart[] = [];
      for (const file of sampled) {
        const buf = await fsReadFile(join(framesDir, file));
        frameParts.push(geminiImageBase64Part(buf.toString("base64"), "image/jpeg"));
      }

      const contextString = buildSfxContext(meta, prior, transcript, sampled.length);
      const userContent: KieGeminiPart[] = [
        geminiTextPart(contextString),
        ...frameParts,
      ];

      const outputText = await callGeminiFlashJson({
        apiKey,
        parts: [
          geminiTextPart(`Instructions:\n${SYSTEM_PROMPT_SFX}`),
          ...userContent,
        ],
        temperature: 0.3,
        maxOutputTokens: 4096,
        responseSchema: SUGGEST_SFX_JSON_SCHEMA as unknown as Record<string, unknown>,
      });

      let parsed: { sfx: Sfx[]; summary: string };
      try {
        parsed = ModelOutputSchema.parse(JSON.parse(outputText));
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Model output failed schema validation: ${msg}`);
      }

      const duration = typeof meta?.duration === "number" ? meta.duration : null;
      const droppedSfx: Array<{ sfx: Sfx; reason: string }> = [];
      const validSfx: Sfx[] = [];
      for (const entry of parsed.sfx) {
        if (duration !== null && entry.timestamp > duration - TIMESTAMP_END_BUFFER_S) {
          droppedSfx.push({ sfx: entry, reason: `timestamp ${entry.timestamp.toFixed(2)}s past duration ${duration.toFixed(2)}s` });
          continue;
        }
        validSfx.push(entry);
      }
      const capped = validSfx.slice(0, MAX_SFX);
      if (validSfx.length > MAX_SFX) {
        for (const entry of validSfx.slice(MAX_SFX)) {
          droppedSfx.push({ sfx: entry, reason: `cap of ${MAX_SFX} entries exceeded` });
        }
      }

      if (droppedSfx.length > 0) {
        console.warn(
          `[suggest_sfx] ${assetId}: dropped ${droppedSfx.length} entries:\n`
            + droppedSfx.map((d) => `  - ${d.reason}: ${JSON.stringify(d.sfx)}`).join("\n"),
        );
      }

      const final = {
        sfx: capped,
        summary: parsed.summary,
        based_on: {
          frames: sampled.length,
          transcript_source: transcript.source,
          dropped_sfx: droppedSfx,
        },
        model: MODEL,
        asset_id: assetId,
      };

      const writeResult = await fs.writeFile(
        assetId,
        ".suggest-sfx.json",
        JSON.stringify(final, null, 2),
        projectSlug,
      );
      if (!writeResult.ok) {
        throw new Error(`Suggestions generated but failed to persist: ${writeResult.error.message}`);
      }

      return { success: true, sfx: capped.length, dropped: droppedSfx.length };
    });
  });
}
