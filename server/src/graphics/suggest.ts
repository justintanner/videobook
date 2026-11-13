import { randomUUID } from "node:crypto";
import type { Engine } from "videobook-engine";
import { getApiKey } from "../api-key.js";
import { chatIntelligenceRequestOptions } from "../chat-models.js";
import type { ClipAnalysis } from "../clip-context.js";
import { clipAnalysisLines, readClipAnalysis, readClipTranscript } from "../clip-context.js";
import { forecastLanguageCall } from "../cost.js";
import type { GoalShortDraft, GoalShortPlan, ShortFinishTitle } from "../goal-short-plan.js";
import { shortFinishTitleIssue, shortStoryboardOf } from "../goal-short-plan.js";
import { shortBriefNames, shortPlannerBrief } from "../goal-short-planner.js";
import type { GoalEstimate } from "../goal-store.js";
import { isCurrentShort, readGoal, requireGoalShortContent } from "../goal-store.js";
import type { ResponsesFn } from "../openai-intelligence.js";
import { buildIntelligenceResponses, firstResponseText, intelligenceRequest } from "../openai-intelligence.js";
import { queue } from "../queue.js";
import { sourceChain } from "./credit.js";
import { readGraphicsDraft } from "./drafts.js";
import { GraphicsServiceError } from "./errors.js";
import type { GraphicsTextSlot } from "./model.js";
import { MAX_GRAPHICS_TEXT_LENGTH } from "./model.js";
import { requireVideo } from "./service.js";
import type { GraphicsSuggestKind, GraphicsSuggestLanguage } from "./slots.js";
import { GRAPHICS_SUGGEST_LANGUAGE_NAMES, GRAPHICS_SUGGEST_SLOTS, graphicsSlotValues, graphicsSuggestLanguage } from "./slots.js";
import { watermarkTitleSlots } from "./templates.js";

export const GRAPHICS_SUGGEST_JOB = "suggest_graphics";

const MAX_TITLE_CHARS = 300;
const MAX_DESCRIPTION_CHARS = 1500;
const MIN_OPTIONS = 3;
const MAX_OPTIONS = 5;
const OPTION_COUNTS: Readonly<Record<GraphicsSuggestKind, number>> = { headline: 5, translate: 3 };
const SUGGEST_TIMEOUT_MS = 55_000;
const WRAPPED = /^["'“‘«「]([^"“”«»「」]*)["'”’»」]$/u;

const SUGGEST_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["options"],
  properties: {
    options: { type: "array", minItems: MIN_OPTIONS, maxItems: MAX_OPTIONS, items: { type: "string" } },
  },
};

type SourcePost = { title: string; description: string };
type SuggestPrompt = { prompt: string; context: GraphicsSuggestions["context"] };

type GraphicsSuggestContext = {
  analysis: ClipAnalysis | null;
  transcript: string | null;
  post: SourcePost | null;
};

export type GraphicsSuggestRequest = {
  kind: GraphicsSuggestKind;
  language: GraphicsSuggestLanguage;
  text: string;
};

type GraphicsSuggestInput = {
  kind?: GraphicsSuggestKind;
  language?: GraphicsSuggestLanguage;
  text?: string;
};

type GraphicsSuggestions = {
  asset_id: string;
  kind: GraphicsSuggestKind;
  slot: GraphicsTextSlot;
  language: GraphicsSuggestLanguage;
  text: string | null;
  options: string[];
  model: string;
  context: { analysis: boolean; transcript: boolean; download: boolean } | null;
};

function clipped(value: unknown, limit: number): string {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

async function readSourcePost(engine: Engine, artifactId: string): Promise<SourcePost | null> {
  const read = await engine.metadata.artifacts.read<{ title?: unknown; description?: unknown }>(artifactId, "original");
  if (!read.ok || !read.value || typeof read.value !== "object") return null;
  const title = clipped(read.value.title, MAX_TITLE_CHARS);
  const description = clipped(read.value.description, MAX_DESCRIPTION_CHARS);
  return title || description ? { title, description } : null;
}

async function readSuggestContext(engine: Engine, artifactId: string): Promise<GraphicsSuggestContext> {
  const ids = [...sourceChain(engine, artifactId)];
  let analysis: ClipAnalysis | null = null;
  let post: SourcePost | null = null;
  for (const id of ids) {
    analysis ??= await readClipAnalysis(engine, id);
    post ??= await readSourcePost(engine, id);
    if (analysis && post) break;
  }
  return { analysis, transcript: await readClipTranscript(engine, ids), post };
}

async function requireSuggestContext(engine: Engine, artifactId: string): Promise<GraphicsSuggestContext> {
  const context = await readSuggestContext(engine, artifactId);
  if (context.analysis || context.transcript || context.post) return context;
  throw new GraphicsServiceError(
    "no_context",
    "There is nothing to write a headline from yet: this video has no analysis, transcript or download title. Transcribe it with /transcribe first, or type the headline.",
  );
}

function draftHeadline(engine: Engine, artifactId: string): string {
  const draft = readGraphicsDraft(engine, artifactId);
  return draft ? graphicsSlotValues(draft.document).headline ?? "" : "";
}

async function graphicsSuggestRequest(engine: Engine, artifactId: string, input: GraphicsSuggestInput): Promise<GraphicsSuggestRequest> {
  requireVideo(engine, artifactId);
  const kind = input.kind ?? "headline";
  if (kind === "headline") {
    await requireSuggestContext(engine, artifactId);
    return { kind, language: input.language ?? graphicsSuggestLanguage(kind, ""), text: "" };
  }
  const text = (input.text ?? draftHeadline(engine, artifactId)).replace(/\s+/gu, " ").trim();
  if (!text) throw new GraphicsServiceError("invalid", "Translate needs a headline. Type or pick one first.");
  if (text.length > MAX_GRAPHICS_TEXT_LENGTH) {
    throw new GraphicsServiceError("invalid", `The headline to translate is longer than ${MAX_GRAPHICS_TEXT_LENGTH} characters.`);
  }
  return { kind, language: input.language ?? graphicsSuggestLanguage(kind, text), text };
}

function postSection(post: SourcePost | null): string {
  if (!post) return "SOURCE POST: none";
  return [
    "SOURCE POST (the title and description where the video was downloaded from; they may be in another language and hold hashtags):",
    post.title ? `Title: ${post.title}` : null,
    post.description ? `Description: ${post.description}` : null,
  ].filter((line): line is string => line !== null).join("\n");
}

function headlinePrompt(context: GraphicsSuggestContext, request: GraphicsSuggestRequest): string {
  const language = GRAPHICS_SUGGEST_LANGUAGE_NAMES[request.language];
  return [
    `Write ${OPTION_COUNTS.headline} headline options for one short vertical video. The headline is the big title drawn over the video, as on TikTok and Reels.`,
    "",
    "RULES:",
    `- Write every headline in ${language}${request.language === "th" ? ", natural and conversational, the way a Thai creator titles a clip" : ""}.`,
    "- Keep each headline short and punchy: at most about 8 words (about 30 characters in Thai), so it fits in two or three lines on a phone screen.",
    "- Ground every headline in the video analysis, transcript and source post below. Never invent names, places, events or facts that are not there.",
    "- Make the options different from each other, for example a question, a reaction, a hook and a plain description.",
    "- No hashtags, no emoji and no quotation marks.",
    "",
    context.analysis ? `VIDEO ANALYSIS:\n${clipAnalysisLines(context.analysis).join("\n")}` : "VIDEO ANALYSIS: none",
    context.transcript ? `TRANSCRIPT:\n${context.transcript}` : "TRANSCRIPT: none",
    postSection(context.post),
  ].join("\n");
}

function translatePrompt(request: GraphicsSuggestRequest): string {
  const language = GRAPHICS_SUGGEST_LANGUAGE_NAMES[request.language];
  return [
    `Translate the headline of a short vertical video into ${language}. The translation is drawn as a smaller second line under the headline.`,
    "",
    "RULES:",
    `- Give ${OPTION_COUNTS.translate} options: a faithful translation first, then freer ones that keep the meaning and the tone.`,
    "- Keep each option short enough for one or two lines on a phone screen.",
    "- Keep names and brand names as they are, and add nothing that is not in the headline.",
    "- No hashtags, no emoji and no quotation marks.",
    "",
    `HEADLINE: ${request.text}`,
  ].join("\n");
}

async function suggestPrompt(engine: Engine, artifactId: string, request: GraphicsSuggestRequest): Promise<SuggestPrompt> {
  if (request.kind === "translate") return { prompt: translatePrompt(request), context: null };
  const context = await requireSuggestContext(engine, artifactId);
  return {
    prompt: headlinePrompt(context, request),
    context: { analysis: context.analysis !== null, transcript: context.transcript !== null, download: context.post !== null },
  };
}

function optionText(value: unknown): string {
  if (typeof value !== "string") return "";
  const single = value.replace(/\s+/gu, " ").trim();
  return (WRAPPED.exec(single)?.[1] ?? single).trim();
}

function parseOptions(raw: string): string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Astra returned suggestions that are not JSON.");
  }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  const seen = new Set<string>();
  const options = (Array.isArray(record.options) ? record.options : []).map(optionText).filter((option) => {
    const key = option.toLocaleLowerCase();
    if (!option || option.length > MAX_GRAPHICS_TEXT_LENGTH || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (options.length === 0) throw new Error("Astra returned no usable suggestions.");
  return options.slice(0, MAX_OPTIONS);
}

export function graphicsSuggestResponses(apiKey: string | undefined): ResponsesFn {
  const astra = chatIntelligenceRequestOptions();
  return buildIntelligenceResponses(apiKey, { timeout: SUGGEST_TIMEOUT_MS, retries: 1, model: astra.model, reasoningEffort: astra.reasoningEffort });
}

export async function suggestGraphicsText(
  engine: Engine,
  artifactId: string,
  request: GraphicsSuggestRequest,
  responses: ResponsesFn,
  signal?: AbortSignal,
): Promise<GraphicsSuggestions> {
  const { prompt, context } = await suggestPrompt(engine, artifactId, request);
  const options = chatIntelligenceRequestOptions();
  const response = await responses(intelligenceRequest({
    input: [{ role: "user", content: prompt }],
    text: { format: { type: "json_schema", name: "graphics_suggestions", schema: SUGGEST_JSON_SCHEMA, strict: true } },
    max_output_tokens: 4096,
  }, options), signal);
  return {
    asset_id: artifactId,
    kind: request.kind,
    slot: GRAPHICS_SUGGEST_SLOTS[request.kind],
    language: request.language,
    text: request.kind === "translate" ? request.text : null,
    options: parseOptions(firstResponseText(response)),
    model: options.model,
    context,
  };
}

export async function requestGraphicsSuggestions(
  engine: Engine,
  bookId: string,
  artifactId: string,
  input: GraphicsSuggestInput,
): Promise<GraphicsSuggestions> {
  const request = await graphicsSuggestRequest(engine, artifactId, input);
  if (!getApiKey("OPENAI_API_KEY")) {
    throw new GraphicsServiceError("not_ready", "Suggestions need an OpenAI API key, and OPENAI_API_KEY is not set.");
  }
  return queue.enqueueAndWait<GraphicsSuggestions>(
    `graphics-suggest-${artifactId}-${randomUUID()}`,
    { type: GRAPHICS_SUGGEST_JOB, bookId, assetId: artifactId, request },
  );
}

const GOAL_TITLE_OPTIONS = 3;
const GOAL_TITLE_MAX_OUTPUT_TOKENS = 4096;
const THAI_SCRIPT = /\p{Script=Thai}/u;
const LATIN_SCRIPT = /\p{Script=Latin}/u;
const GOAL_TITLE_RETRY = "Your last answer broke the rules: every headline must be in Thai and every English line in English, each short enough for its lines. Write the three options again.";
const GOAL_TITLE_NO_HEADLINE = "The saved TikTok watermark template has no headline, so Finish cannot burn a title. Add a headline to that template in the graphics editor, or finish without a title.";

const GOAL_TITLE_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["options"],
  properties: {
    options: {
      type: "array",
      minItems: GOAL_TITLE_OPTIONS,
      maxItems: GOAL_TITLE_OPTIONS,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["headline", "secondary"],
        properties: { headline: { type: "string" }, secondary: { type: "string" } },
      },
    },
  },
};

export type GoalTitleShort = { brief: string; draft: GoalShortDraft | null };
type GoalTitleSource = GoalTitleShort & { plan: GoalShortPlan };
export type GoalTitleOptions = { goal_id: string; options: ShortFinishTitle[]; model: string };

function labelled(label: string): string {
  return label.trim() || "no label";
}

function shortSubjectLines(plan: GoalShortPlan): string[] {
  if (plan.version === 4) return [`MAIN CHARACTER: ${plan.character.name}, ${plan.character.description}`];
  if (plan.sourceImages.length === 0) return ["SOURCE IMAGES: none"];
  return ["SOURCE IMAGES:", ...plan.sourceImages.map((image, index) => `Source image ${index + 1}: ${labelled(image.label)}`)];
}

function shortContextLines(source: GoalTitleSource): string[] {
  const { plan } = source;
  const names = shortBriefNames(source, plan);
  const storyboard = shortStoryboardOf(plan);
  return [
    `BRIEF: ${shortPlannerBrief(source.brief, names.references, null, names.storyboard)}`,
    `WORKING TITLE: ${plan.title}`,
    "BEATS, in order:",
    ...plan.segments.map((segment, index) => `${index + 1}. ${segment.prompt}`),
    ...shortSubjectLines(plan),
    ...(storyboard ? [`STORYBOARD VIDEO: ${labelled(storyboard.video.label)}`] : []),
  ];
}

export function goalTitlePrompt(source: GoalTitleSource): string {
  return [
    `Write ${GOAL_TITLE_OPTIONS} title options for one short phone video. Each option is a headline in Thai, drawn big over the video as on TikTok and Reels, and an English line drawn smaller under it.`,
    "",
    "RULES:",
    "- Write every headline in Thai, natural and conversational, the way a Thai creator titles a clip: at most about 8 words (about 30 characters).",
    "- Write every English line in English, at most about 10 words: a natural line that says what its headline says, or adds to it.",
    "- Ground every option in the short below. Never invent names, places, events or facts that are not there.",
    "- Make the options different from each other, for example a question, a reaction, a hook and a plain description.",
    "- Never mention the source images, the storyboard, prompts or how the video was made.",
    "- No hashtags, no emoji and no quotation marks.",
    "",
    "THE SHORT:",
    ...shortContextLines(source),
  ].join("\n");
}

export function goalTitleEstimate(source: GoalTitleSource): GoalEstimate {
  const prompt = goalTitlePrompt(source);
  const { model } = chatIntelligenceRequestOptions();
  const requests = [prompt, `${prompt}\n${GOAL_TITLE_RETRY}`].map((input) => forecastLanguageCall(model, input, GOAL_TITLE_MAX_OUTPUT_TOKENS));
  return {
    usd: requests.every((request) => request.status !== "unavailable") ? requests.reduce((sum, request) => sum + request.usd, 0) : null,
    warnings: [...new Set(requests.flatMap((request) => request.warnings))],
  };
}

function usableTitle(value: unknown): ShortFinishTitle | null {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const title = { headline: optionText(record.headline), secondary: optionText(record.secondary) };
  if (!THAI_SCRIPT.test(title.headline)) return null;
  if (THAI_SCRIPT.test(title.secondary) || !LATIN_SCRIPT.test(title.secondary)) return null;
  return shortFinishTitleIssue(title) === null ? title : null;
}

function parseTitleOptions(raw: string): ShortFinishTitle[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const record = parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : {};
  return (Array.isArray(record.options) ? record.options : []).flatMap((option) => {
    const title = usableTitle(option);
    return title ? [title] : [];
  });
}

function distinctTitles(titles: readonly ShortFinishTitle[]): ShortFinishTitle[] {
  const seen = new Set<string>();
  return titles.filter((title) => {
    const key = title.headline.toLocaleLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function goalTitleSource(engine: Engine, goalId: string): GoalTitleSource {
  const goal = readGoal(engine, goalId);
  if (!isCurrentShort(goal.planVersion)) throw new GraphicsServiceError("invalid", "Only a short made by /goal can have a burned title.");
  const content = requireGoalShortContent(engine, goal);
  if (!content.plan) throw new GraphicsServiceError("not_ready", "This short has no plan yet. Wait for planning to finish.");
  return { brief: content.brief, draft: content.draft, plan: content.plan };
}

export async function suggestGoalTitles(engine: Engine, goalId: string, responses: ResponsesFn, signal?: AbortSignal): Promise<GoalTitleOptions> {
  const prompt = goalTitlePrompt(goalTitleSource(engine, goalId));
  const options = chatIntelligenceRequestOptions();
  const ask = async (retry: boolean): Promise<ShortFinishTitle[]> => parseTitleOptions(firstResponseText(await responses(intelligenceRequest({
    input: [{ role: "user", content: prompt }, ...(retry ? [{ role: "user" as const, content: GOAL_TITLE_RETRY }] : [])],
    text: { format: { type: "json_schema", name: "goal_titles", schema: GOAL_TITLE_JSON_SCHEMA, strict: true } },
    max_output_tokens: GOAL_TITLE_MAX_OUTPUT_TOKENS,
  }, options), signal)));
  const first = distinctTitles(await ask(false));
  const titles = first.length >= GOAL_TITLE_OPTIONS ? first : distinctTitles([...first, ...await ask(true)]);
  if (titles.length === 0) throw new Error("Astra did not write a title in Thai with an English line. Write title again, or type the title.");
  return { goal_id: goalId, options: titles.slice(0, GOAL_TITLE_OPTIONS), model: options.model };
}

export async function requestGoalTitles(engine: Engine, bookId: string, goalId: string): Promise<GoalTitleOptions> {
  goalTitleSource(engine, goalId);
  if (!watermarkTitleSlots(engine, "tiktok").headline) throw new GraphicsServiceError("invalid", GOAL_TITLE_NO_HEADLINE);
  if (!getApiKey("OPENAI_API_KEY")) {
    throw new GraphicsServiceError("not_ready", "Writing a title needs an OpenAI API key, and OPENAI_API_KEY is not set. Type the title instead.");
  }
  return queue.enqueueAndWait<GoalTitleOptions>(`goal-title-${goalId}-${randomUUID()}`, { type: GRAPHICS_SUGGEST_JOB, bookId, goalId });
}
