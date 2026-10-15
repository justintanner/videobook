import type { Engine } from "videobook-engine";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest, type ResponsesFn } from "../openai-intelligence.js";
import { readAssetTranscript } from "../transcript-projection.js";
import { isAnalyzableVideo, VIDEO_ANALYSIS_FILE } from "../video-analysis-projection.js";
import type { PostPlatform, PostView } from "./post-contract.js";
import {
  normalizePostTags,
  PLATFORM_CAPTION_LIMITS,
  PLATFORM_NAMES,
  PLATFORM_TAG_LIMITS,
  POST_COPY_LANGUAGE_NAMES,
  type PostCopyLanguage,
} from "./post-copy-format.js";

const MAX_TRANSCRIPT_CHARS = 4000;
const MAX_PROMPT_CHARS = 1000;
const MAX_SCENES = 12;

export type PostCopyAnalysis = {
  summary: string;
  mood: string;
  setting: string;
  subjects: string[];
  actions: string[];
  tags: string[];
  scenes: string[];
  textOnScreen: string[];
};

export type PostCopyContext = {
  label: string;
  analysis: PostCopyAnalysis | null;
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

function sceneLines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_SCENES).map((scene) => {
    const record = scene && typeof scene === "object" ? scene as Record<string, unknown> : {};
    const at = typeof record.timestamp === "number" ? `${record.timestamp.toFixed(1)}s: ` : "";
    const description = text(record.description);
    return description ? `${at}${description}` : "";
  }).filter(Boolean);
}

export function postCopyAnalysisFrom(raw: unknown): PostCopyAnalysis | null {
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  const analysis: PostCopyAnalysis = {
    summary: text(record.summary),
    mood: text(record.mood),
    setting: text(record.setting),
    subjects: texts(record.subjects),
    actions: texts(record.actions),
    tags: texts(record.tags),
    scenes: sceneLines(record.scenes),
    textOnScreen: texts(record.textOnScreen),
  };
  const empty = !analysis.summary && analysis.scenes.length === 0 && analysis.tags.length === 0 && analysis.subjects.length === 0;
  return empty ? null : analysis;
}

async function readAnalysis(engine: Engine, assetId: string): Promise<PostCopyAnalysis | null> {
  const read = await engine.files.read(assetId, VIDEO_ANALYSIS_FILE);
  if (!read.ok) return null;
  try {
    return postCopyAnalysisFrom(JSON.parse(read.value.toString()) as unknown);
  } catch {
    return null;
  }
}

function sourceArtifactIds(post: PostView): string[] {
  const source = post.definition.source;
  if (!source) return [];
  return [...new Set([source.artifactId, source.snapshotArtifactId].filter((id): id is string => Boolean(id)))];
}

export async function postAnalysisTarget(engine: Engine, post: PostView): Promise<PostAnalysisTarget | null> {
  const ids = sourceArtifactIds(post);
  for (const assetId of ids) {
    if (await readAnalysis(engine, assetId)) return { assetId, analyzable: true, analyzed: true };
  }
  const assetId = ids[0];
  if (!assetId) return null;
  const artifact = engine.artifacts.get(assetId);
  return { assetId, analyzable: artifact.ok && isAnalyzableVideo(artifact.value.kind), analyzed: false };
}

async function readTranscriptText(engine: Engine, assetIds: readonly string[]): Promise<string | null> {
  for (const assetId of assetIds) {
    const transcript = await readAssetTranscript(engine, assetId);
    if (transcript.kind === "timed" || transcript.kind === "plain") {
      const value = transcript.text.trim();
      if (value) return value.slice(0, MAX_TRANSCRIPT_CHARS);
    }
  }
  return null;
}

export async function readPostCopyContext(engine: Engine, post: PostView): Promise<PostCopyContext> {
  const ids = sourceArtifactIds(post);
  let analysis: PostCopyAnalysis | null = null;
  for (const assetId of ids) {
    analysis = await readAnalysis(engine, assetId);
    if (analysis) break;
  }
  const prompts = post.definition.lineage
    .map((step) => text(step.prompt).slice(0, MAX_PROMPT_CHARS))
    .filter(Boolean)
    .slice(-2);
  const label = post.definition.lineage.find((step) => step.cellId === post.definition.source?.cellId)?.label ?? post.label;
  return { label, analysis, transcript: await readTranscriptText(engine, ids), prompts };
}

function listLine(name: string, values: readonly string[]): string | null {
  return values.length ? `${name}: ${values.join(", ")}` : null;
}

function analysisSection(analysis: PostCopyAnalysis | null): string {
  if (!analysis) return "VIDEO ANALYSIS: none available. Rely only on the clip label and prompts below.";
  const lines = [
    analysis.summary ? `Summary: ${analysis.summary}` : null,
    analysis.mood ? `Mood: ${analysis.mood}` : null,
    analysis.setting ? `Setting: ${analysis.setting}` : null,
    listLine("Subjects", analysis.subjects),
    listLine("Actions", analysis.actions),
    listLine("Analysis tags", analysis.tags),
    listLine("Text on screen", analysis.textOnScreen),
    analysis.scenes.length ? `Scenes:\n${analysis.scenes.map((scene) => `- ${scene}`).join("\n")}` : null,
  ].filter((line): line is string => line !== null);
  return `VIDEO ANALYSIS:\n${lines.join("\n")}`;
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
    "- Keep the voice human; no clichés like \"you won't believe\".",
    "- The caption holds no hashtags. Put hashtags in tags, without the # sign and without spaces.",
    `- Return at most ${maxTags} tags. Tags may be ${language}${request.language === "en" ? "" : " or English"} words that people on ${platform} search for.`,
    `- The caption plus its tags must stay under ${limit} characters.`,
    instruction ? `\nINSTRUCTION FROM THE CREATOR: ${instruction}` : "",
    rewriteSection(request),
    `CLIP LABEL: ${context.label}`,
    analysisSection(context.analysis),
    context.transcript ? `TRANSCRIPT:\n${context.transcript}` : "TRANSCRIPT: none",
    context.prompts.length ? `HOW THE CLIP WAS MADE (generation prompts):\n${context.prompts.map((prompt) => `- ${prompt}`).join("\n")}` : "",
  ].filter((line) => line !== "").join("\n");
}

export function parsePostCopy(raw: string, request: PostCopyRequest): Pick<PostCopyDraft, "caption" | "tags"> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Astra returned post copy that is not JSON.");
  }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const caption = text(record.caption);
  if (!caption) throw new Error("Astra returned an empty caption.");
  return { caption, tags: normalizePostTags(texts(record.tags), PLATFORM_TAG_LIMITS[request.platform]) };
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
