import type { Engine } from "videobook-engine";
import { z } from "zod";
import type { OpenAiResponseInputContent } from "@apicity/openai";
import { registerJobHandler } from "../queue.js";
import { getApiKey } from "../api-key.js";
import {
  INTELLIGENCE_MODEL,
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "../openai-intelligence.js";
import { withLocalLease } from "./_lease.js";
import {
  SfxSchema,
  buildSfxContext,
  loadAssetForAnalysis,
  sampleFrames,
  type Sfx,
} from "../tools/_suggest-shared.js";

const MAX_SFX = 8;
const TIMESTAMP_END_BUFFER_S = 0.05;

type SuggestSfxPayload = {
  type: "suggest_sfx";
  assetId: string;
  assetDir: string;
  bookId: string;
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

export function registerSuggestSfxJob(fs: Engine): void {
  registerJobHandler("suggest_sfx", async (payload, ctx) => {
    const { assetId } = payload as SuggestSfxPayload;

    return withLocalLease(fs, assetId, ctx, "analyze", async () => {
      const apiKey = getApiKey("OPENAI_API_KEY");
      if (!apiKey) throw new Error("OPENAI_API_KEY environment variable is not set");

      const loaded = await loadAssetForAnalysis(fs, assetId);
      if (!loaded.ok) throw new Error(loaded.error.message);
      const { frameNames, transcript, meta, prior } = loaded.value;

      const sampled = sampleFrames(frameNames);
      const frameParts: OpenAiResponseInputContent[] = [];
      for (const file of sampled) {
        const frameRead = await fs.files.read(assetId, `original_frames/${file}`);
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

      const contextString = buildSfxContext(meta, prior, transcript, sampled.length);
      const userContent: OpenAiResponseInputContent[] = [
        { type: "input_text", text: contextString },
        ...frameParts,
      ];

      const responses = buildIntelligenceResponses(apiKey);
      const response = await responses(intelligenceRequest({
        instructions: SYSTEM_PROMPT_SFX,
        input: [{ role: "user", content: userContent }],
        text: {
          format: {
            type: "json_schema",
            name: "suggested_sound_effects",
            schema: SUGGEST_SFX_JSON_SCHEMA,
            strict: true,
          },
        },
        max_output_tokens: 4096,
      }), ctx.signal);
      const outputText = firstResponseText(response);

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
        model: INTELLIGENCE_MODEL,
        asset_id: assetId,
      };

      const writeResult = await fs.files.write(assetId, ".suggest-sfx.json", JSON.stringify(final, null, 2)
      );
      if (!writeResult.ok) {
        throw new Error(`Suggestions generated but failed to persist: ${writeResult.error.message}`);
      }

      return { success: true, sfx: capped.length, dropped: droppedSfx.length };
    });
  });
}
