import type { Engine } from "videobook-engine";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { logger } from "../logger.js";
import { registerJobHandler } from "../queue.js";
import { MAX_AUTOMATIC_TAGS, vocabularyFor } from "../tag-vocabulary.js";
import type { StructuredTagRecord } from "../asset-tag-extraction.js";
import { requireApiKey } from "../api-key.js";
import { withLocalLease } from "./_lease.js";
import { enqueueAssetTagging } from "./tag-asset.js";
import {
  INTELLIGENCE_MODEL,
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
  type ResponsesFn,
} from "../openai-intelligence.js";
type DescribeImagePayload = {
  type: "describe_image";
  sourceAssetId: string;
  sourceImageFilename: string;
  // When omitted, the job runs in **analysis-only** mode: vision is run and
  // `.original.analysis.json` is cached on the source, but no script-* asset
  // is written. Used by the auto-on-upload flow (`process_image`), which only
  // needs the cached JSON, not a user-visible script asset.
  assetId?: string;
  bookId: string;
};

export type DescribeImageResult = {
  prompt: string;
  shot?: string;
  pose?: string;
  /**
   * Editorial tags for grouping, asked for in the same request as the
   * reproduction prompt so tagging an image costs no second vision call.
   */
  tags?: StructuredTagRecord[];
};



const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = join(__dirname, "../guides/image_reproduction_guide.md");

export const SCRIPT_FILENAME = "original.md";
export const ANALYSIS_FILENAME = ".original.analysis.json";
const VISION_MODEL = INTELLIGENCE_MODEL;
export const PROMPT_CHAR_LIMIT = 1900;

const DESCRIBE_IMAGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    prompt: { type: "string", maxLength: PROMPT_CHAR_LIMIT },
    shot: { type: "string" },
    pose: { type: "string" },
    tags: {
      type: "array",
      maxItems: MAX_AUTOMATIC_TAGS,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          facet: { type: "string", enum: ["people", "places", "editing"] },
          label: { type: "string" },
        },
        required: ["facet", "label"],
      },
    },
  },
  required: ["prompt", "shot", "pose", "tags"],
};

/**
 * The tagging half of the instructions. The prompt half describes how to
 * reproduce the image; this half describes how to file it. Offering the
 * vocabulary inline is what makes separate clips converge on one spelling —
 * anything outside it is discarded on the way in, so asking for invented
 * terms would only waste tokens.
 */
function buildTaggingPrompt(): string {
  return (
    "\n\nTAGS: also return a \"tags\" array of {facet, label} records that help an editor "
    + "find and group this image with related footage. Emit a tag only when the image itself "
    + "supports it, prefer few precise tags over many, and return an empty array when nothing "
    + "is worth grouping by. Never tag how good or how moody the image looks, and never name a "
    + "real person or a real place.\n"
    + `- facet "people" — one of: ${vocabularyFor("people").join(", ")}.\n`
    + `- facet "places" — the setting, plus interior/exterior and day/night when visible. `
    + `Common settings: ${vocabularyFor("places").join(", ")}. A concrete unlisted setting is fine.\n`
    + `- facet "editing" — framing and coverage only: ${vocabularyFor("editing").join(", ")}. `
    + "A still image cannot show camera movement, so never claim pan, tilt, tracking or handheld."
  );
}

function mimeForFilename(filename: string): "image/jpeg" | "image/png" | "image/webp" {
  const ext = extname(filename).replace(/^\./, "").toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return "image/jpeg";
}

function buildSystemPrompt(guide: string): string {
  return (
    "You are an expert image-to-prompt analyst. You look at an image and emit a reproduction-ready prompt " +
    "for an image generator. Follow the guide below exactly. Return ONLY a JSON object matching the schema " +
    "described in the guide. Do not wrap it in prose or markdown fences.\n\n" +
    `HARD LIMIT: the "prompt" field MUST be ${PROMPT_CHAR_LIMIT} characters or fewer. Trim detail to fit; never exceed.\n\n` +
    "REGISTER: If the image reads as a casual phone/social snapshot (candid framing, available light, " +
    "unretouched skin, compression artifacts), use the Authentic-photo register from the guide. Do not " +
    "inject editorial film-stock, 'cinematic', 'masterpiece', or pro-film vocabulary into snapshots. " +
    "Default to authentic phone capture when in doubt.\n\n" +
    `--- REPRODUCTION GUIDE ---\n${guide}\n--- END GUIDE ---`
    + buildTaggingPrompt()
  );
}

export function formatMarkdown(r: DescribeImageResult): string {
  const lines: string[] = [];
  lines.push(r.prompt.trim(), "");
  const rows: Array<[string, string | undefined]> = [
    ["Shot", r.shot],
    ["Pose", r.pose],
  ];
  for (const [label, value] of rows) {
    if (value && value.trim()) {
      lines.push(`${label}: ${value.trim()}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

export function mimeForImageFilename(filename: string): "image/jpeg" | "image/png" | "image/webp" {
  return mimeForFilename(filename);
}

function buildResponses(apiKey: string | undefined): ResponsesFn {
  return buildIntelligenceResponses(apiKey);
}

export async function describeImageBytes(
  bytes: Buffer,
  mime: "image/jpeg" | "image/png" | "image/webp",
  responses?: ResponsesFn,
): Promise<DescribeImageResult> {
  const fn = responses ?? buildResponses(requireApiKey("OPENAI_API_KEY"));
  const guide = await readFile(GUIDE_PATH, "utf-8");
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  const response = await fn(intelligenceRequest({
    instructions: buildSystemPrompt(guide),
    input: [{
      role: "user",
      content: [
        { type: "input_image", image_url: dataUrl, detail: "high" },
        { type: "input_text", text: "Analyze this image and produce the reproduction prompt as a JSON object matching the schema in the guide." },
      ],
    }],
    text: {
      format: {
        type: "json_schema",
        name: "image_reproduction",
        schema: DESCRIBE_IMAGE_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 2048,
  }));
  const content = firstResponseText(response);
  if (!content) {
    throw new Error(`Vision provider returned no content (status=${response.status})`);
  }
  const parsed = JSON.parse(content) as DescribeImageResult;
  if (!parsed.prompt || typeof parsed.prompt !== "string") {
    throw new Error(`Vision model returned no prompt field. Got keys: ${Object.keys(parsed).join(",")}`);
  }
  if (parsed.prompt.length > PROMPT_CHAR_LIMIT) {
    logger.warn("description-truncated", { count: parsed.prompt.length, limit: PROMPT_CHAR_LIMIT });
    parsed.prompt = parsed.prompt.slice(0, PROMPT_CHAR_LIMIT).trimEnd();
  }
  return parsed;
}

export function registerDescribeImageJob(engine: Engine): void {
  registerJobHandler("describe_image", async (payload, ctx) => {
    const {
      sourceAssetId,
      sourceImageFilename,
      assetId: scriptAssetId,
    } = payload as DescribeImagePayload;

    // When scriptAssetId is set, the queue wrote a pending row on it; claim
    // the lease so the wrapper finalizes it (ready/error). Analysis-only
    // mode runs on the source asset, which already exists at status='ready'.
    const targetAssetId = scriptAssetId ?? sourceAssetId;
    return withLocalLease(engine, targetAssetId, ctx, "describe", async () => {
      const responses = buildResponses(requireApiKey("OPENAI_API_KEY"));

      const readResult = await engine.files.read(sourceAssetId, sourceImageFilename);
      if (!readResult.ok) {
        throw new Error(`Failed to read image ${sourceImageFilename} for ${sourceAssetId}: ${readResult.error.message}`);
      }
      const buffer = Buffer.from(readResult.value);
      const mime = mimeForFilename(sourceImageFilename);

      const parsed = await describeImageBytes(buffer, mime, responses);

      const analysisJson = JSON.stringify(parsed, null, 2);
      const cacheResult = await engine.files.write(sourceAssetId, ANALYSIS_FILENAME, analysisJson);
      if (!cacheResult.ok) {
        if (cacheResult.error.code === "NOT_FOUND") {
          return { success: false, sourceAssetId, scriptAssetId, reason: "source_deleted" };
        }
        logger.warn("description-cache-failed", { assetId: sourceAssetId, error: cacheResult.error });
      }

      // The structured tags rode along with the prompt, so tagging is now a
      // read of what this request already returned.
      await enqueueAssetTagging(engine, sourceAssetId);

      if (scriptAssetId) {
        const markdown = formatMarkdown(parsed);
        const writeResult = await engine.files.write(scriptAssetId, SCRIPT_FILENAME, markdown);
        if (!writeResult.ok) {
          throw new Error(`Failed to write ${SCRIPT_FILENAME} to ${scriptAssetId}: ${writeResult.error.message}`);
        }

        await engine.metadata.artifacts.write(scriptAssetId, "original", {
            origin: "describe_image",
            sourceAssetId,
            model: VISION_MODEL,
            processed_at: new Date().toISOString(),
            variant: "full",
          }
        );
      }

      return { success: true, sourceAssetId, scriptAssetId, prompt: parsed.prompt };
    });
  });
}
