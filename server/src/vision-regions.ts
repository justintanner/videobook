import type { OpenAiResponseInputContent } from "@apicity/openai";
import { z } from "zod";
import {
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
} from "./openai-intelligence.js";
import type { KeywordOccupiedRegion } from "./remotion/keyword-placement.js";

/**
 * Shared "what must an overlay not cover" vision pass: send labelled frames to
 * the intelligence model and get back face/text/graphic boxes per frame,
 * normalized to 0..1. Used by keyword-graphics placement (per-cue frames) and
 * watermark placement (evenly sampled frames).
 */

const OCCUPIED_REGIONS_JSON_SCHEMA = {
  type: "object",
  required: ["frames"],
  additionalProperties: false,
  properties: {
    frames: {
      type: "array",
      items: {
        type: "object",
        required: ["cue_id", "occupied_regions"],
        additionalProperties: false,
        properties: {
          cue_id: { type: "string" },
          occupied_regions: {
            type: "array",
            items: {
              type: "object",
              required: ["kind", "confidence", "x", "y", "width", "height"],
              additionalProperties: false,
              properties: {
                kind: { type: "string", enum: ["face", "text", "graphic"] },
                confidence: { type: "number", minimum: 0, maximum: 1 },
                x: { type: "number", minimum: 0, maximum: 1000 },
                y: { type: "number", minimum: 0, maximum: 1000 },
                width: { type: "number", minimum: 0.001, maximum: 1000 },
                height: { type: "number", minimum: 0.001, maximum: 1000 },
              },
            },
          },
        },
      },
    },
  },
} as const;

const modelOccupiedRegionSchema = z.object({
  kind: z.enum(["face", "text", "graphic"]),
  confidence: z.number().min(0).max(1),
  x: z.number().min(0).max(1000),
  y: z.number().min(0).max(1000),
  width: z.number().positive().max(1000),
  height: z.number().positive().max(1000),
}).strict().refine(
  (region) => region.x + region.width <= 1000.001 && region.y + region.height <= 1000.001,
  { message: "occupied region extends beyond the frame" },
);

const occupiedRegionsResponseSchema = z.object({
  frames: z.array(z.object({
    cue_id: z.string().min(1),
    occupied_regions: z.array(modelOccupiedRegionSchema),
  }).strict()),
}).strict();

interface VisionRegionFrame {
  id: string;
  /** Extra context appended after `cue_id=<id>; ` in the frame's text part. */
  label: string;
  buffer: Buffer;
}

interface DetectOccupiedRegionsOptions {
  apiKey: string;
  signal: AbortSignal;
  instructions: string;
  schemaName: string;
  /** Prefix for validation error messages (e.g. "Keyword placement"). */
  errorLabel: string;
  timeout?: number;
  maxOutputTokens?: number;
}

export function decodeOccupiedRegionsResponse(
  raw: string,
  expectedCueIds: readonly string[],
  errorLabel: string,
): Map<string, KeywordOccupiedRegion[]> {
  let parsed: z.infer<typeof occupiedRegionsResponseSchema>;
  try {
    parsed = occupiedRegionsResponseSchema.parse(JSON.parse(raw));
  } catch (error) {
    throw new Error(`${errorLabel} vision response was invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const actual = parsed.frames.map((frame) => frame.cue_id);
  if (actual.length !== expectedCueIds.length
    || new Set(actual).size !== actual.length
    || expectedCueIds.some((cueId) => !actual.includes(cueId))) {
    throw new Error(`${errorLabel} vision response did not contain exactly one result per cue`);
  }
  return new Map(parsed.frames.map((frame) => [
    frame.cue_id,
    frame.occupied_regions.map((region): KeywordOccupiedRegion => ({
      kind: region.kind,
      confidence: region.confidence,
      x: region.x / 1000,
      y: region.y / 1000,
      width: region.width / 1000,
      height: region.height / 1000,
    })),
  ]));
}

export async function detectOccupiedRegions(
  frames: VisionRegionFrame[],
  opts: DetectOccupiedRegionsOptions,
): Promise<Map<string, KeywordOccupiedRegion[]>> {
  const {
    apiKey,
    signal,
    instructions,
    schemaName,
    errorLabel,
    timeout = 240_000,
    maxOutputTokens = 8192,
  } = opts;
  const content: OpenAiResponseInputContent[] = [];
  for (const frame of frames) {
    content.push(
      {
        type: "input_text",
        text: `cue_id=${frame.id}; ${frame.label}`,
      },
      {
        type: "input_image",
        image_url: `data:image/jpeg;base64,${frame.buffer.toString("base64")}`,
        detail: "high",
      },
    );
  }
  const responses = buildIntelligenceResponses(apiKey, { timeout });
  const response = await responses(intelligenceRequest({
    instructions,
    input: [{ role: "user", content }],
    text: {
      format: {
        type: "json_schema",
        name: schemaName,
        schema: OCCUPIED_REGIONS_JSON_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: maxOutputTokens,
  }), signal);
  return decodeOccupiedRegionsResponse(
    firstResponseText(response),
    frames.map((frame) => frame.id),
    errorLabel,
  );
}
