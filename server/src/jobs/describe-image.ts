import type { Engine } from "videobook-engine";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import type { OpenAiResponseRequest, OpenAiResponseResponse } from "@apicity/openai";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import { withLocalLease } from "./_lease.js";
import {
  KIE_GEMINI_FLASH_MODEL,
  callGeminiFlashJson,
  geminiImageDataUrlPart,
  geminiTextPart,
} from "../kie-gemini.js";
type DescribeImagePayload = {
  type: "describe_image";
  sourceAssetId: string;
  sourceImageFilename: string;
  // When omitted, the job runs in **analysis-only** mode: vision is run and
  // `.original.analysis.json` is cached on the source, but no script-* asset
  // is written. Used by the auto-on-upload flow (`process_image`), which only
  // needs the cached JSON, not a user-visible script asset.
  assetId?: string;
  projectSlug: string;
};

export type DescribeImageResult = {
  prompt: string;
  shot?: string;
  pose?: string;
};

export type ResponsesFn = (req: OpenAiResponseRequest, signal?: AbortSignal) => Promise<OpenAiResponseResponse>;

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = join(__dirname, "../guides/image_reproduction_guide.md");

export const SCRIPT_FILENAME = "original.md";
export const ANALYSIS_FILENAME = ".original.analysis.json";
export const VISION_MODEL = KIE_GEMINI_FLASH_MODEL;
export const PROMPT_CHAR_LIMIT = 1900;

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

export function buildResponses(apiKey: string | undefined): ResponsesFn {
  if (!apiKey) {
    throw new Error("KIE_API_KEY is not set");
  }
  return async (req, signal) => {
    const parts = responseRequestToGeminiParts(req);
    const outputText = await callGeminiFlashJson({
      apiKey,
      parts,
      temperature: typeof req.temperature === "number" ? req.temperature : undefined,
      maxOutputTokens: typeof req.max_output_tokens === "number" ? req.max_output_tokens : undefined,
      timeout: 180_000,
      signal,
    });

    return {
      status: "completed",
      model: VISION_MODEL,
      output: [{
        type: "message",
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: outputText, annotations: [] }],
      }],
    } as unknown as OpenAiResponseResponse;
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function appendResponseContent(parts: ReturnType<typeof geminiTextPart>[], content: unknown): void {
  if (typeof content === "string") {
    parts.push(geminiTextPart(content));
    return;
  }

  if (!Array.isArray(content)) return;

  for (const item of content) {
    if (!isRecord(item)) continue;
    if (item.type === "input_text" && typeof item.text === "string") {
      parts.push(geminiTextPart(item.text));
    } else if (item.type === "input_image" && typeof item.image_url === "string") {
      parts.push(geminiImageDataUrlPart(item.image_url));
    }
  }
}

function responseRequestToGeminiParts(req: OpenAiResponseRequest): ReturnType<typeof geminiTextPart>[] {
  const parts: ReturnType<typeof geminiTextPart>[] = [];
  if (typeof req.instructions === "string" && req.instructions.trim()) {
    parts.push(geminiTextPart(`Instructions:\n${req.instructions}`));
  }

  const input = req.input as unknown;
  if (typeof input === "string") {
    parts.push(geminiTextPart(input));
  } else if (Array.isArray(input)) {
    for (const item of input) {
      if (!isRecord(item)) continue;
      appendResponseContent(parts, item.content);
    }
  }

  if (parts.length === 0) {
    parts.push(geminiTextPart("Return the requested JSON object."));
  }
  return parts;
}

export function firstResponseText(response: OpenAiResponseResponse): string {
  const texts: string[] = [];
  for (const item of response.output) {
    if (item.type !== "message") continue;
    for (const c of item.content) {
      if (c.type === "output_text") texts.push(c.text);
      else if (c.type === "refusal") throw new Error(`Vision provider refused: ${c.refusal}`);
    }
  }
  return texts.join("").trim();
}

export async function describeImageBytes(
  bytes: Buffer,
  mime: "image/jpeg" | "image/png" | "image/webp",
  responses?: ResponsesFn,
): Promise<DescribeImageResult> {
  const fn = responses ?? buildResponses(requireApiKey("KIE_API_KEY"));
  const guide = await readFile(GUIDE_PATH, "utf-8");
  const dataUrl = `data:${mime};base64,${bytes.toString("base64")}`;
  const response = await fn({
    model: VISION_MODEL,
    instructions: buildSystemPrompt(guide),
    input: [{
      role: "user",
      content: [
        { type: "input_image", image_url: dataUrl, detail: "high" },
        { type: "input_text", text: "Analyze this image and produce the reproduction prompt as a JSON object matching the schema in the guide." },
      ],
    }],
    text: { format: { type: "json_object" } },
    temperature: 0.4,
    max_output_tokens: 2048,
  });
  const content = firstResponseText(response);
  if (!content) {
    throw new Error(`Vision provider returned no content (status=${response.status})`);
  }
  const parsed = JSON.parse(content) as DescribeImageResult;
  if (!parsed.prompt || typeof parsed.prompt !== "string") {
    throw new Error(`Vision model returned no prompt field. Got keys: ${Object.keys(parsed).join(",")}`);
  }
  if (parsed.prompt.length > PROMPT_CHAR_LIMIT) {
    console.warn(`[describe_image] prompt ${parsed.prompt.length} > ${PROMPT_CHAR_LIMIT} chars, truncating`);
    parsed.prompt = parsed.prompt.slice(0, PROMPT_CHAR_LIMIT).trimEnd();
  }
  return parsed;
}

export function registerDescribeImageJob(fs: Engine): void {
  registerJobHandler("describe_image", async (payload, ctx) => {
    const {
      sourceAssetId,
      sourceImageFilename,
      assetId: scriptAssetId,
      projectSlug,
    } = payload as DescribeImagePayload;

    // When scriptAssetId is set, the queue wrote a pending row on it; claim
    // the lease so the wrapper finalizes it (ready/error). Analysis-only
    // mode runs on the source asset, which already exists at status='ready'.
    const targetAssetId = scriptAssetId ?? sourceAssetId;
    return withLocalLease(fs, projectSlug, targetAssetId, ctx, "describe", async () => {
      const responses = buildResponses(requireApiKey("KIE_API_KEY"));

      const readResult = await fs.files.read(sourceAssetId, sourceImageFilename, projectSlug);
      if (!readResult.ok) {
        throw new Error(`Failed to read image ${sourceImageFilename} for ${sourceAssetId}: ${readResult.error.message}`);
      }
      const buffer = Buffer.from(readResult.value);
      const mime = mimeForFilename(sourceImageFilename);

      const parsed = await describeImageBytes(buffer, mime, responses);

      const analysisJson = JSON.stringify(parsed, null, 2);
      const cacheResult = await fs.files.write(sourceAssetId, ANALYSIS_FILENAME, analysisJson, projectSlug);
      if (!cacheResult.ok) {
        if (cacheResult.error.code === "NOT_FOUND") {
          return { success: false, sourceAssetId, scriptAssetId, reason: "source_deleted" };
        }
        console.warn(
          `[describe_image] Failed to cache analysis on source ${sourceAssetId}: ${cacheResult.error.message}`,
        );
      }

      if (scriptAssetId) {
        const markdown = formatMarkdown(parsed);
        const writeResult = await fs.files.write(scriptAssetId, SCRIPT_FILENAME, markdown, projectSlug);
        if (!writeResult.ok) {
          throw new Error(`Failed to write ${SCRIPT_FILENAME} to ${scriptAssetId}: ${writeResult.error.message}`);
        }

        await fs.metadata.artifacts.write(
          scriptAssetId,
          "original",
          {
            origin: "describe_image",
            sourceAssetId,
            model: VISION_MODEL,
            processed_at: new Date().toISOString(),
            variant: "full",
          },
          projectSlug,
        );
      }

      return { success: true, sourceAssetId, scriptAssetId, prompt: parsed.prompt };
    });
  });
}
