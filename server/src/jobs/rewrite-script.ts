import type { ClipfirstFs } from "clipfirst-fs";
import { firstContent } from "@apicity/openai";
import { registerJobHandler } from "../queue.js";
import { deletePendingTask } from "./pending-task.js";
import {
  buildVisionChat,
  formatMarkdown,
  PROMPT_CHAR_LIMIT,
  SCRIPT_FILENAME,
  VISION_MODEL,
  type DescribeImageResult,
  type VisionChatFn,
} from "./describe-image.js";

type Platform = "ig" | "tiktok" | "youtube";

type RewriteScriptPayload = {
  type: "rewrite_script";
  assetId: string;
  sourceAssetId: string;
  projectSlug: string;
  tldr?: boolean;
  platform?: Platform | null;
  customPrompt?: string | null;
};

function platformGuidance(p: Platform): string {
  switch (p) {
    case "ig":
      return (
        "PLATFORM: Instagram. Target 4:5 portrait or 1:1 square framing. " +
        "Aesthetic-candid register — curated but unstaged: natural daylight or soft indoor light, " +
        "warm/golden cast acceptable, light film grain tolerated. Mild VSCO-style lift in shadows; " +
        "skin kept natural with no heavy beautify. Avoid HDR crunch, over-saturation, and harsh " +
        "on-camera flash unless the image is clearly a flash-aesthetic shot. Default device read: " +
        "iPhone main camera. Never use editorial/film-stock vocabulary unless the image is clearly " +
        "a professional editorial photo."
      );
    case "tiktok":
      return (
        "PLATFORM: TikTok. Target 9:16 vertical framing. Raw phone snapshot energy — candid framing, " +
        "slight motion softness, mild compression artifacts, auto-HDR lifted blacks. Indoor scenes: " +
        "ring-light rim or warm tungsten acceptable; at night, harsh on-camera flash is on-brand. " +
        "Front-camera selfies (with visible mirror/arm) are native to the platform. Skin unretouched, " +
        "tiny chromatic aberration on high-contrast edges. Never apply editorial polish, cinematic " +
        "color grading, or named film-stock vocabulary (Portra, Cinestill, etc.). No 'cinematic', " +
        "'masterpiece', 'editorial' — this is a phone snapshot."
      );
    case "youtube":
      return (
        "PLATFORM: YouTube. Default to 16:9 landscape unless the image is clearly a Short (then 9:16). " +
        "Slightly elevated production versus TikTok: punchier contrast, cleaner key light, faces " +
        "expressive and readable at small thumbnail sizes. Colour can sit slightly saturated for " +
        "thumbnail legibility but avoid over-stylised filters. Keep the result photographic rather " +
        "than graphic-design; no logo overlays, no title text baked in."
      );
  }
}

const FIELD_LABEL_TO_KEY: Record<string, Exclude<keyof DescribeImageResult, "prompt">> = {
  Subject: "subject",
  Composition: "composition",
  Lighting: "lighting",
  Camera: "camera",
  Palette: "palette",
  Style: "style",
  Mood: "mood",
  Post: "post",
};

function parseMarkdownToResult(md: string): DescribeImageResult {
  const lines = md.split("\n");
  const promptLines: string[] = [];
  let i = 0;
  while (i < lines.length && lines[i].trim() !== "") {
    promptLines.push(lines[i]);
    i++;
  }
  const result: DescribeImageResult = { prompt: promptLines.join("\n").trim() };
  while (i < lines.length && lines[i].trim() === "") i++;
  for (; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(/^([A-Z][a-z]+):\s*(.+)$/);
    if (!match) continue;
    const key = FIELD_LABEL_TO_KEY[match[1]];
    if (key) result[key] = match[2].trim();
  }
  return result;
}

function buildFullSystemPrompt(platform: Platform | null): string {
  const platformBlock = platform ? `\n\n--- PLATFORM ---\n${platformGuidance(platform)}\n--- END PLATFORM ---` : "";
  return (
    "You rewrite image-reproduction prompt documents. The input describes one scene, split into a prose " +
    "prompt paragraph and labeled breakdown fields (Subject, Composition, Lighting, Camera, Palette, Style, " +
    "Mood, Post). You apply a user transformation and emit a rewritten document in the same JSON shape.\n\n" +
    "Return ONLY a JSON object with keys: prompt (string, REQUIRED), and any of subject, composition, " +
    "lighting, camera, palette, style, mood, post (strings, optional — include the same fields that appear " +
    "in the input). No prose outside the JSON. No markdown fences.\n\n" +
    `HARD LIMIT: the "prompt" field MUST be ${PROMPT_CHAR_LIMIT} characters or fewer.\n\n` +
    "When a transformation instruction is provided, apply it rigorously: any subject being replaced must " +
    "be ABSENT from every field of the output. Rewrite every field end-to-end so it describes the scene " +
    "AFTER the transformation. Adapt palette, mood, subject, and composition naturally to the new content; " +
    "do NOT simply string-replace nouns.\n\n" +
    "Preserve from the original: framing/angle/shot type, camera distance, lighting direction and time of " +
    "day, overall capture register (authentic phone snapshot vs editorial), and aspect ratio cues." +
    platformBlock
  );
}

function buildTldrSystemPrompt(platform: Platform | null): string {
  const platformBlock = platform ? `\n\n--- PLATFORM ---\n${platformGuidance(platform)}\n--- END PLATFORM ---` : "";
  return (
    "You rewrite image-reproduction prompt documents into a 1–2 sentence TLDR. The input may be a full " +
    "document (prose paragraph + labeled fields) or a TLDR already. You emit a tight 1–2 sentence prompt " +
    "(roughly 40–70 words) capturing subject, setting, framing, light, and mood.\n\n" +
    "Match the input's register: if it reads as a casual phone/social photo, include authentic-capture cues " +
    "(mild grain, subtle sensor noise, tiny chromatic aberration, no beauty filter, unedited skin) and AVOID " +
    "words like 'editorial', 'cinematic', 'masterpiece', or named film stocks (Portra, Cinestill, etc.). " +
    "Only use film-stock / cinematic vocabulary if the input clearly references a pro editorial or film " +
    "still. Never apply camera vocabulary to a painting or render.\n\n" +
    "Return ONLY a JSON object: { \"prompt\": string }. No breakdown fields. No prose outside the JSON. " +
    "No markdown fences.\n\n" +
    "When a transformation instruction is provided, apply it rigorously: any subject being replaced must " +
    "NOT appear in the output. Describe only the scene AFTER the transformation." +
    platformBlock
  );
}

function buildUserMessage(current: DescribeImageResult, customPrompt: string | null): string {
  const parts: string[] = [
    "CURRENT DOCUMENT (JSON):",
    JSON.stringify(current, null, 2),
  ];
  if (customPrompt && customPrompt.trim().length > 0) {
    parts.push(
      "",
      "TRANSFORMATION INSTRUCTION (apply this; any subject being replaced must vanish from every field):",
      customPrompt.trim(),
    );
  } else {
    parts.push(
      "",
      "No transformation instruction. Rewrite the document to match any new platform/variant guidance above while preserving the scene content.",
    );
  }
  return parts.join("\n");
}

async function rewriteText(
  chat: VisionChatFn,
  current: DescribeImageResult,
  opts: { tldr: boolean; platform: Platform | null; customPrompt: string | null },
): Promise<DescribeImageResult> {
  const system = opts.tldr ? buildTldrSystemPrompt(opts.platform) : buildFullSystemPrompt(opts.platform);
  const user = buildUserMessage(current, opts.customPrompt);

  const response = await chat({
    model: VISION_MODEL,
    stream: false,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
    response_format: { type: "json_object" },
    temperature: 0.4,
    max_completion_tokens: 2048,
  });

  const content = firstContent(response);
  if (!content) {
    throw new Error(`Rewrite provider returned no content (keys: ${Object.keys(response ?? {}).join(",")})`);
  }
  const parsed = JSON.parse(content) as DescribeImageResult;
  if (!parsed.prompt || typeof parsed.prompt !== "string") {
    throw new Error(`Rewrite model returned no prompt field. Got keys: ${Object.keys(parsed).join(",")}`);
  }
  if (parsed.prompt.length > PROMPT_CHAR_LIMIT) {
    parsed.prompt = parsed.prompt.slice(0, PROMPT_CHAR_LIMIT).trimEnd();
  }
  return parsed;
}

function formatTldrMarkdown(r: DescribeImageResult): string {
  return `${r.prompt.trim()}\n`;
}

export function registerRewriteScriptJob(fs: ClipfirstFs): void {
  registerJobHandler("rewrite_script", async (payload) => {
    const {
      assetId: scriptAssetId,
      sourceAssetId,
      projectSlug,
      tldr,
      platform,
      customPrompt,
    } = payload as RewriteScriptPayload;

    console.log(
      `[rewrite_script] START script=${scriptAssetId} project=${projectSlug} ` +
      `tldr=${!!tldr} platform=${platform ?? "none"} ` +
      `customPrompt=${customPrompt ? `"${customPrompt.slice(0, 40)}..."` : "none"}`,
    );

    const chat = buildVisionChat(process.env.OPENAI_API_KEY, process.env.KIE_API_KEY);

    const readResult = await fs.readFile(scriptAssetId, SCRIPT_FILENAME, projectSlug);
    if (!readResult.ok) {
      throw new Error(`Failed to read ${SCRIPT_FILENAME} from ${scriptAssetId}: ${readResult.error.message}`);
    }
    const currentMarkdown = Buffer.from(readResult.value).toString("utf-8");
    const current = parseMarkdownToResult(currentMarkdown);
    if (!current.prompt) {
      throw new Error(`Script ${scriptAssetId} has no parseable prompt in ${SCRIPT_FILENAME}`);
    }

    const rewritten = await rewriteText(chat, current, {
      tldr: tldr === true,
      platform: platform ?? null,
      customPrompt: customPrompt ?? null,
    });

    const markdown = tldr ? formatTldrMarkdown(rewritten) : formatMarkdown(rewritten);
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
        model: VISION_MODEL,
        processed_at: new Date().toISOString(),
        variant: tldr ? "tldr" : "full",
        ...(platform ? { platform } : {}),
        ...(customPrompt ? { customPrompt } : {}),
      },
      projectSlug,
    );

    await deletePendingTask(fs, scriptAssetId, projectSlug);

    console.log(`[rewrite_script] DONE ${scriptAssetId} (${rewritten.prompt.length} chars)`);
    return { success: true, scriptAssetId, prompt: rewritten.prompt };
  });
}
