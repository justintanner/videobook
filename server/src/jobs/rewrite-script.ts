import type { Engine } from "videobook-engine";
import { registerJobHandler } from "../queue.js";
import { requireApiKey } from "../api-key.js";
import {
  INTELLIGENCE_MODEL,
  buildIntelligenceResponses,
  firstResponseText,
  intelligenceRequest,
  type ResponsesFn,
} from "../openai-intelligence.js";
import { withLocalLease } from "./_lease.js";
import {
  formatMarkdown,
  PROMPT_CHAR_LIMIT,
  SCRIPT_FILENAME,
  type DescribeImageResult,
} from "./describe-image.js";
import { platformGuidance, type Platform } from "../platform-guidance.js";

type RewriteScriptPayload = {
  type: "rewrite_script";
  assetId: string;
  sourceAssetId: string;
  bookId: string;
  tldr?: boolean;
  platform?: Platform | null;
  customPrompt?: string | null;
};

const FIELD_LABEL_TO_KEY: Record<string, "shot" | "pose"> = {
  Shot: "shot",
  Pose: "pose",
};

const FULL_REWRITE_JSON_SCHEMA = {
  type: "object",
  required: ["prompt", "shot", "pose"],
  additionalProperties: false,
  properties: {
    prompt: { type: "string" },
    shot: { anyOf: [{ type: "string" }, { type: "null" }] },
    pose: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
} as const;

const TLDR_REWRITE_JSON_SCHEMA = {
  type: "object",
  required: ["prompt"],
  additionalProperties: false,
  properties: {
    prompt: { type: "string" },
  },
} as const;

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
    "prompt paragraph and two labeled breakdown fields (Shot, Pose). You apply a user transformation and " +
    "emit a rewritten document in the same JSON shape.\n\n" +
    "Return ONLY a JSON object with keys: prompt (string, REQUIRED), shot (string or null), pose (string or " +
    "null). Use null when an optional field is absent from the input. The shot field is shot size + camera " +
    "angle in standard cinematography terms (e.g. 'medium close-up, eye-level'). The pose field describes " +
    "body geometry only (weight, stance, rotation, limb positions); for close-ups, also describe implied " +
    "off-frame posture in one trailing sentence. The pose field must not mention clothing, hair, face, or " +
    "setting. No prose outside the JSON. No markdown fences.\n\n" +
    `HARD LIMIT: the "prompt" field MUST be ${PROMPT_CHAR_LIMIT} characters or fewer.\n\n` +
    "When a transformation instruction is provided, apply it rigorously: any subject being replaced must " +
    "be ABSENT from every field of the output. Rewrite every field end-to-end so it describes the scene " +
    "AFTER the transformation. Adapt subject, setting, and mood naturally to the new content; do NOT " +
    "simply string-replace nouns.\n\n" +
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
  responses: ResponsesFn,
  current: DescribeImageResult,
  opts: { tldr: boolean; platform: Platform | null; customPrompt: string | null },
  signal?: AbortSignal,
): Promise<DescribeImageResult> {
  const system = opts.tldr ? buildTldrSystemPrompt(opts.platform) : buildFullSystemPrompt(opts.platform);
  const user = buildUserMessage(current, opts.customPrompt);

  const response = await responses(intelligenceRequest({
    instructions: system,
    input: [{ role: "user", content: user }],
    text: {
      format: {
        type: "json_schema",
        name: opts.tldr ? "rewrite_script_tldr" : "rewrite_script_full",
        schema: opts.tldr ? TLDR_REWRITE_JSON_SCHEMA : FULL_REWRITE_JSON_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 2048,
  }), signal);

  const content = firstResponseText(response);
  if (!content) {
    throw new Error(`Rewrite provider returned no content (status=${response.status})`);
  }
  const raw = JSON.parse(content) as Record<string, unknown>;
  if (!raw.prompt || typeof raw.prompt !== "string") {
    throw new Error(`Rewrite model returned no prompt field. Got keys: ${Object.keys(raw).join(",")}`);
  }
  const parsed: DescribeImageResult = {
    prompt: raw.prompt,
    ...(typeof raw.shot === "string" ? { shot: raw.shot } : {}),
    ...(typeof raw.pose === "string" ? { pose: raw.pose } : {}),
  };
  if (parsed.prompt.length > PROMPT_CHAR_LIMIT) {
    parsed.prompt = parsed.prompt.slice(0, PROMPT_CHAR_LIMIT).trimEnd();
  }
  return parsed;
}

function formatTldrMarkdown(r: DescribeImageResult): string {
  return `${r.prompt.trim()}\n`;
}

export function registerRewriteScriptJob(engine: Engine): void {
  registerJobHandler("rewrite_script", async (payload, ctx) => {
    const {
      assetId: scriptAssetId,
      sourceAssetId,
      tldr,
      platform,
      customPrompt,
    } = payload as RewriteScriptPayload;

    return withLocalLease(engine, scriptAssetId, ctx, "rewrite_script", async () => {
      const responses = buildIntelligenceResponses(requireApiKey("OPENAI_API_KEY"));

      const readResult = await engine.files.read(scriptAssetId, SCRIPT_FILENAME);
      if (!readResult.ok) {
        throw new Error(`Failed to read ${SCRIPT_FILENAME} from ${scriptAssetId}: ${readResult.error.message}`);
      }
      const currentMarkdown = Buffer.from(readResult.value).toString("utf-8");
      const current = parseMarkdownToResult(currentMarkdown);
      if (!current.prompt) {
        throw new Error(`Script ${scriptAssetId} has no parseable prompt in ${SCRIPT_FILENAME}`);
      }

      const rewritten = await rewriteText(responses, current, {
        tldr: tldr === true,
        platform: platform ?? null,
        customPrompt: customPrompt ?? null,
      }, ctx.signal);

      const markdown = tldr ? formatTldrMarkdown(rewritten) : formatMarkdown(rewritten);
      const writeResult = await engine.files.write(scriptAssetId, SCRIPT_FILENAME, markdown);
      if (!writeResult.ok) {
        throw new Error(`Failed to write ${SCRIPT_FILENAME} to ${scriptAssetId}: ${writeResult.error.message}`);
      }

      await engine.metadata.artifacts.write(scriptAssetId, "original", {
          origin: "describe_image",
          sourceAssetId,
          model: INTELLIGENCE_MODEL,
          processed_at: new Date().toISOString(),
          variant: tldr ? "tldr" : "full",
          ...(platform ? { platform } : {}),
          ...(customPrompt ? { customPrompt } : {}),
        }
      );

      return { success: true, scriptAssetId, prompt: rewritten.prompt };
    });
  });
}
