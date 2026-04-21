import type { ClipfirstFs } from "clipfirst-fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import { openai, withRetry, withFallback, textPart, imageBase64Part, firstContent } from "@apicity/openai";
import type { OpenAiChatRequest, OpenAiChatResponse } from "@apicity/openai";
import { kie } from "@apicity/kie";
import { registerJobHandler } from "../queue.js";
import { deletePendingTask } from "./pending-task.js";

type DescribeImagePayload = {
  type: "describe_image";
  sourceAssetId: string;
  sourceImageFilename: string;
  assetId: string;
  projectSlug: string;
  tldr?: boolean;
};

type DescribeImageResult = {
  prompt: string;
  subject?: string;
  composition?: string;
  lighting?: string;
  camera?: string;
  palette?: string;
  style?: string;
  mood?: string;
  post?: string;
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const GUIDE_PATH = join(__dirname, "../guides/image_reproduction_guide.md");

const SCRIPT_FILENAME = "original.md";
const VISION_MODEL = "gpt-5.2";
const PROMPT_CHAR_LIMIT = 1900;

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
    `--- REPRODUCTION GUIDE ---\n${guide}\n--- END GUIDE ---`
  );
}

function buildTldrSystemPrompt(): string {
  return (
    "You are an expert image-to-prompt analyst. Describe this image as a single, tight reproduction " +
    "prompt of 1–2 sentences (roughly 40–70 words) that captures subject, setting, framing, light, and mood. " +
    "Return ONLY a JSON object: { \"prompt\": string }. No breakdown fields. No markdown fences, no prose."
  );
}

function formatMarkdown(r: DescribeImageResult): string {
  const lines: string[] = [];
  lines.push(r.prompt.trim(), "");
  const rows: Array<[string, string | undefined]> = [
    ["Subject", r.subject],
    ["Composition", r.composition],
    ["Lighting", r.lighting],
    ["Camera", r.camera],
    ["Palette", r.palette],
    ["Style", r.style],
    ["Mood", r.mood],
    ["Post", r.post],
  ];
  for (const [label, value] of rows) {
    if (value && value.trim()) {
      lines.push(`${label}: ${value.trim()}`);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function formatTldrMarkdown(r: DescribeImageResult): string {
  return `${r.prompt.trim()}\n`;
}

export function registerDescribeImageJob(fs: ClipfirstFs): void {
  registerJobHandler("describe_image", async (payload) => {
    const { sourceAssetId, sourceImageFilename, assetId: scriptAssetId, projectSlug, tldr } = payload as DescribeImagePayload;

    console.log(`[describe_image] START source=${sourceAssetId} script=${scriptAssetId} project=${projectSlug} tldr=${!!tldr}`);

    const openaiKey = process.env.OPENAI_API_KEY;
    const kieKey = process.env.KIE_API_KEY;
    if (!openaiKey && !kieKey) {
      throw new Error("Neither OPENAI_API_KEY nor KIE_API_KEY is set");
    }

    const readResult = await fs.readFile(sourceAssetId, sourceImageFilename, projectSlug);
    if (!readResult.ok) {
      throw new Error(`Failed to read image ${sourceImageFilename} for ${sourceAssetId}: ${readResult.error.message}`);
    }
    const buffer = Buffer.from(readResult.value);
    const mime = mimeForFilename(sourceImageFilename);

    const systemPrompt = tldr
      ? buildTldrSystemPrompt()
      : buildSystemPrompt(await readFile(GUIDE_PATH, "utf-8"));
    const userInstruction = tldr
      ? "Produce the 1–2 sentence TLDR prompt for this image."
      : "Analyze this image and produce the reproduction prompt as specified.";
    const userContent = [
      textPart(userInstruction),
      imageBase64Part(buffer.toString("base64"), mime, "high"),
    ];

    const providers: Array<(req: OpenAiChatRequest, signal?: AbortSignal) => Promise<OpenAiChatResponse>> = [];
    if (openaiKey) {
      const p = openai({ apiKey: openaiKey, timeout: 120_000 });
      providers.push(withRetry(p.post.v1.chat.completions, { retries: 2, baseMs: 500 }));
    }
    if (kieKey) {
      const p = kie({ apiKey: kieKey, timeout: 120_000 });
      providers.push(withRetry(p.chat.completions, { retries: 2, baseMs: 500 }));
    }
    const chat = providers.length > 1 ? withFallback(providers) : providers[0];

    const response = await chat({
      model: VISION_MODEL,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userContent },
      ],
      response_format: { type: "json_object" },
      temperature: 0.4,
      max_completion_tokens: 2048,
    });

    const content = firstContent(response);
    if (!content) {
      throw new Error(`Vision provider returned no content (keys: ${Object.keys(response ?? {}).join(",")})`);
    }

    const parsed = JSON.parse(content) as DescribeImageResult;
    if (!parsed.prompt || typeof parsed.prompt !== "string") {
      throw new Error(`Vision model returned no prompt field. Got keys: ${Object.keys(parsed).join(",")}`);
    }

    if (!tldr && parsed.prompt.length > PROMPT_CHAR_LIMIT) {
      console.warn(`[describe_image] prompt ${parsed.prompt.length} > ${PROMPT_CHAR_LIMIT} chars, truncating`);
      parsed.prompt = parsed.prompt.slice(0, PROMPT_CHAR_LIMIT).trimEnd();
    }

    const markdown = tldr ? formatTldrMarkdown(parsed) : formatMarkdown(parsed);
    const writeResult = await fs.writeFile(scriptAssetId, SCRIPT_FILENAME, markdown, projectSlug);
    if (!writeResult.ok) {
      throw new Error(`Failed to write ${SCRIPT_FILENAME} to ${scriptAssetId}: ${writeResult.error.message}`);
    }

    await fs.writeMetadata(
      scriptAssetId,
      "original",
      {
        origin: "describe_image",
        sourceAssetId,
        processed_at: new Date().toISOString(),
        ...(tldr ? { variant: "tldr" } : {}),
      },
      projectSlug,
    );

    await deletePendingTask(fs, scriptAssetId, projectSlug);

    console.log(`[describe_image] DONE source=${sourceAssetId} → ${scriptAssetId} (${parsed.prompt.length} chars)`);
    return { success: true, sourceAssetId, scriptAssetId, prompt: parsed.prompt };
  });
}
