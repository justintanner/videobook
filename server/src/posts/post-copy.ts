import type { Engine } from "videobook-engine";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { LIGHTNING_POST_TAGS } from "../lightning-defaults.js";
import { clipAnalysisLines, readClipAnalysis, readClipTranscript, type ClipAnalysis } from "../clip-context.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest, type ResponsesFn } from "../openai-intelligence.js";
import { isAnalyzableVideo } from "../video-analysis-projection.js";
import type { PostPlatform, PostView } from "./post-contract.js";
import {
  normalizePostTags,
  PLATFORM_CAPTION_LIMITS,
  PLATFORM_NAMES,
  PLATFORM_TAG_LIMITS,
  POST_COPY_LANGUAGE_NAMES,
  type PostCopyLanguage,
} from "./post-copy-format.js";

const MAX_PROMPT_CHARS = 1000;

export type PostCopyContext = {
  label: string;
  analysis: ClipAnalysis | null;
  transcript: string | null;
  prompts: string[];
};

export type PostCopyRequest = {
  platform: PostPlatform;
  language: PostCopyLanguage;
  instruction?: string;
  caption?: string;
  tags?: string[];
};

export type PostCopyDraft = {
  caption: string;
  tags: string[];
  platform: PostPlatform;
  language: PostCopyLanguage;
  model: string;
  analyzed: boolean;
};

export type PostAnalysisTarget = { assetId: string; analyzable: boolean; analyzed: boolean };

const POST_COPY_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["caption", "tags"],
  properties: {
    caption: { type: "string" },
    tags: { type: "array", items: { type: "string" } },
  },
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function texts(value: unknown): string[] {
  return Array.isArray(value) ? value.map(text).filter(Boolean) : [];
}

function sourceArtifactIds(post: PostView): string[] {
  const source = post.definition.source;
  if (!source) return [];
  return [...new Set([source.artifactId, source.snapshotArtifactId].filter((id): id is string => Boolean(id)))];
}

export async function postAnalysisTarget(engine: Engine, post: PostView): Promise<PostAnalysisTarget | null> {
  const ids = sourceArtifactIds(post);
  for (const assetId of ids) {
    if (await readClipAnalysis(engine, assetId)) return { assetId, analyzable: true, analyzed: true };
  }
  const assetId = ids[0];
  if (!assetId) return null;
  const artifact = engine.artifacts.get(assetId);
  return { assetId, analyzable: artifact.ok && isAnalyzableVideo(artifact.value.kind), analyzed: false };
}

export async function readPostCopyContext(engine: Engine, post: PostView): Promise<PostCopyContext> {
  const ids = sourceArtifactIds(post);
  let analysis: ClipAnalysis | null = null;
  for (const assetId of ids) {
    analysis = await readClipAnalysis(engine, assetId);
    if (analysis) break;
  }
  const prompts = post.definition.lineage
    .map((step) => text(step.prompt).slice(0, MAX_PROMPT_CHARS))
    .filter(Boolean)
    .slice(-2);
  const label = post.definition.lineage.find((step) => step.cellId === post.definition.source?.cellId)?.label ?? post.label;
  return { label, analysis, transcript: await readClipTranscript(engine, ids), prompts };
}

function analysisSection(analysis: ClipAnalysis | null): string {
  if (!analysis) return "VIDEO ANALYSIS: none available. Rely only on the clip label and prompts below.";
  return `VIDEO ANALYSIS:\n${clipAnalysisLines(analysis).join("\n")}`;
}

function rewriteSection(request: PostCopyRequest): string {
  const caption = request.caption?.trim();
  const tags = request.tags?.length ? request.tags.map((tag) => `#${tag}`).join(" ") : "";
  if (!caption && !tags) return "";
  return `\nCURRENT DRAFT (rewrite it; keep what already works):\nCaption: ${caption || "(empty)"}\nTags: ${tags || "(none)"}\n`;
}

export function buildPostCopyPrompt(context: PostCopyContext, request: PostCopyRequest): string {
  const platform = PLATFORM_NAMES[request.platform];
  const language = POST_COPY_LANGUAGE_NAMES[request.language];
  const limit = PLATFORM_CAPTION_LIMITS[request.platform];
  const maxTags = PLATFORM_TAG_LIMITS[request.platform];
  const instruction = request.instruction?.trim();
  return [
    `Write the social post copy for one short video clip that will be posted on ${platform}.`,
    "",
    "RULES:",
    `- Write the caption in ${language}${request.language === "th" ? ", natural and conversational, the way a Thai creator writes" : ""}.`,
    "- Ground every claim in the video analysis, transcript and prompts below. Never invent names, places, events or facts that are not there.",
    "- By default the caption is a short title of one or two words plus one or two emoji, like \"Golden hour 🌅✨\". Write longer copy only when the instruction asks for it.",
    "- The title describes this clip. Do not reuse another video's caption.",
    "- Keep the voice human; no clichés like \"you won't believe\".",
    "- The caption holds no hashtags. Put hashtags in tags, without the # sign and without spaces.",
    `- Return at most ${maxTags} tags. Tags may be ${language}${request.language === "en" ? "" : " or English"} words that people on ${platform} search for.`,
    request.platform === "tiktok" && request.tags === undefined
      ? "- Include the tags fyp and bkk unless the creator already supplied tags."
      : "",
    `- The caption plus its tags must stay under ${limit} characters.`,
    instruction ? `\nINSTRUCTION FROM THE CREATOR: ${instruction}` : "",
    rewriteSection(request),
    `CLIP LABEL: ${context.label}`,
    analysisSection(context.analysis),
    context.transcript ? `TRANSCRIPT:\n${context.transcript}` : "TRANSCRIPT: none",
    context.prompts.length ? `HOW THE CLIP WAS MADE (generation prompts):\n${context.prompts.map((prompt) => `- ${prompt}`).join("\n")}` : "",
  ].filter((line) => line !== "").join("\n");
}

function parsePostCopy(raw: string, request: PostCopyRequest): Pick<PostCopyDraft, "caption" | "tags"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Astra returned post copy that is not JSON.");
  }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const caption = text(record.caption);
  if (!caption) throw new Error("Astra returned an empty caption.");
  const limit = PLATFORM_TAG_LIMITS[request.platform];
  const parsedTags = normalizePostTags(texts(record.tags), limit);
  const tags = request.platform === "tiktok" && request.tags === undefined
    ? normalizePostTags([...LIGHTNING_POST_TAGS, ...parsedTags], limit)
    : parsedTags;
  return { caption, tags };
}

export function postCopyResponses(apiKey: string | undefined, options: { baseURL?: string; retries?: number } = {}): ResponsesFn {
  const astra = chatIntelligenceRequestOptions();
  return buildIntelligenceResponses(apiKey, { timeout: 120_000, model: astra.model, reasoningEffort: astra.reasoningEffort, ...options });
}

export async function draftPostCopy(responses: ResponsesFn, context: PostCopyContext, request: PostCopyRequest, signal?: AbortSignal): Promise<PostCopyDraft> {
  const options = chatIntelligenceRequestOptions();
  const response = await responses(intelligenceRequest({
    input: [{ role: "user", content: buildPostCopyPrompt(context, request) }],
    text: { format: { type: "json_schema", name: "post_copy", schema: POST_COPY_JSON_SCHEMA, strict: true } },
    max_output_tokens: 4096,
  }, options), signal);
  const copy = parsePostCopy(firstResponseText(response), request);
  return { ...copy, platform: request.platform, language: request.language, model: options.model, analyzed: context.analysis !== null };
}
