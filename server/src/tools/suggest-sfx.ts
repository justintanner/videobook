import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { VideocityFs } from "vc-engine";
import { z } from "zod";
import { join } from "node:path";
import { readFile as fsReadFile } from "node:fs/promises";
import { createOpenAi, withRetry, textPart, imageBase64Part, firstContent } from "@apicity/openai";
import type { OpenAiContentPart } from "@apicity/openai";
import type { ToolDef } from "./tool-def.js";
import {
  MODEL,
  SfxSchema,
  buildSfxContext,
  loadAssetForAnalysis,
  sampleFrames,
  type Sfx,
} from "./_suggest-shared.js";

const MAX_SFX = 8;
const TIMESTAMP_END_BUFFER_S = 0.05;

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

export function suggestSfxDef(fs: VideocityFs): ToolDef {
  return {
    name: "suggest_sfx",
    description:
      "Analyze a video asset (frames + transcript + metadata) and return structured SFX suggestions: " +
      "timestamps, slug types, and descriptions. Persists to .suggest-sfx.json. " +
      "Requires a transcript — run /transcribe first if missing. Use /apply-sfx to mix the result.",
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

      const loaded = await loadAssetForAnalysis(fs, assetId, project_slug);
      if (!loaded.ok) {
        return {
          isError: true as const,
          content: [{ type: "text" as const, text: loaded.error.message }],
        };
      }
      const { framesDir, frameNames, transcript, meta, prior } = loaded.value;

      const sampled = sampleFrames(frameNames);
      const frameParts: OpenAiContentPart[] = [];
      for (const file of sampled) {
        const buf = await fsReadFile(join(framesDir, file));
        frameParts.push(imageBase64Part(buf.toString("base64"), "image/jpeg", "low"));
      }

      const contextString = buildSfxContext(meta, prior, transcript, sampled.length);
      const userContent: OpenAiContentPart[] = [
        textPart(contextString),
        ...frameParts,
      ];

      const provider = createOpenAi({ apiKey, timeout: 240_000 });
      const call = withRetry(provider.post.v1.chat.completions, { retries: 2, baseMs: 500 });

      let outputText: string;
      try {
        const result = await call({
          model: MODEL,
          stream: false,
          messages: [
            { role: "system", content: SYSTEM_PROMPT_SFX },
            { role: "user", content: userContent },
          ],
          response_format: {
            type: "json_schema",
            json_schema: {
              name: "suggest_sfx_result",
              schema: SUGGEST_SFX_JSON_SCHEMA as unknown as Record<string, unknown>,
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

      let parsed: { sfx: Sfx[]; summary: string };
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

export function registerSuggestSfxTool(server: McpServer, fs: VideocityFs): void {
  const def = suggestSfxDef(fs);
  server.tool(def.name, def.description, def.schema, def.handler);
}
