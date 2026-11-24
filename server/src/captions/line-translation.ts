import { createHash } from "node:crypto";
import type { Engine, Job } from "videobook-engine";
import { z } from "zod";
import type { AnalysisComponentSpec, AnalysisComponentStatus } from "../analysis-components.js";
import {
  analysisComponentKey,
  enqueueAnalysisComponent,
  isActiveJob,
  latestJobWhere,
  retainedAnalysisComponents,
} from "../analysis-components.js";
import { getApiKey } from "../api-key.js";
import type { TranslationListRequest } from "../jobs/_translate-transcript.js";
import { requestTranslationList } from "../jobs/_translate-transcript.js";
import type { ResponsesFn } from "../openai-intelligence.js";
import { INTELLIGENCE_MODEL } from "../openai-intelligence.js";
import { subtitleLanguageName } from "../subtitle-languages.js";
import { captionLanguageCodeSchema } from "./model.js";

export const CAPTION_LINE_TRANSLATION_JOB = "caption_line_translation";
const LINE_TRANSLATION_FORMAT = "translated_subtitle_lines";
const MAX_OUTPUT_TOKENS = 32_000;

export const lineTranslationValueSchema = z.object({
  language: captionLanguageCodeSchema,
  lines: z.array(z.object({ source: z.string().min(1), text: z.string() })),
});

export type CaptionLineTranslation = z.infer<typeof lineTranslationValueSchema>;

export interface CaptionLineTranslationState {
  language: string;
  key: string;
  status: AnalysisComponentStatus;
  jobId: number | null;
  error: string | null;
  missing: number;
  available: boolean;
}

export interface CaptionLineTranslationRequest {
  bookId: string;
  artifactId: string;
  mediaHash: string;
  language: string;
  sourceLanguage: string | null;
  sources: string[];
  edited: Record<string, string>;
  force: boolean;
}

export interface CaptionLineTranslationInput {
  language: string;
  sourceLanguage: string | null;
  sources: readonly string[];
  edited: Readonly<Record<string, string>>;
  memory: ReadonlyMap<string, string>;
}

interface GivenLine {
  source: string;
  given: string | undefined;
}

export function lineTranslationSpec(language: string): AnalysisComponentSpec {
  return { component: `caption-lines.${language}`, version: 1, jobType: CAPTION_LINE_TRANSLATION_JOB };
}

export function lineTranslationKey(mediaHash: string, language: string, sources: readonly string[]): string {
  return analysisComponentKey(lineTranslationSpec(language), {
    sourceHash: mediaHash,
    options: { language, model: INTELLIGENCE_MODEL, lines: createHash("sha256").update(JSON.stringify(sources)).digest("hex") },
  });
}

export function captionLineMemoryFor(engine: Engine, artifactId: string, language: string): Map<string, string> {
  const memory = new Map<string, string>();
  for (const stored of retainedAnalysisComponents(engine, artifactId, lineTranslationSpec(language), lineTranslationValueSchema)) {
    for (const line of stored.value.lines) if (!memory.has(line.source)) memory.set(line.source, line.text);
  }
  return memory;
}

export function readCaptionLineMemory(engine: Engine, artifactId: string, languages: readonly string[]): Record<string, Record<string, string>> {
  return Object.fromEntries(languages.map((language) => [language, Object.fromEntries(captionLineMemoryFor(engine, artifactId, language))]));
}

function latestLanguageJob(engine: Engine, artifactId: string, language: string): Job | null {
  return latestJobWhere(engine, CAPTION_LINE_TRANSLATION_JOB, (job) => job.payload.sourceArtifactId === artifactId && job.payload.language === language);
}

function lineTranslationUnavailable(): string | null {
  return getApiKey("OPENAI_API_KEY") ? null : "Translation lines need OPENAI_API_KEY. Write the missing lines yourself or remove the translation.";
}

export function captionLineTranslationState(
  engine: Engine,
  input: { artifactId: string; mediaHash: string; language: string; sources: readonly string[]; missing: number },
): CaptionLineTranslationState {
  const unavailable = lineTranslationUnavailable();
  const base = {
    language: input.language,
    key: lineTranslationKey(input.mediaHash, input.language, input.sources),
    missing: input.missing,
    available: unavailable === null,
  };
  const job = latestLanguageJob(engine, input.artifactId, input.language);
  if (job && isActiveJob(job)) return { ...base, status: job.state === "queued" ? "queued" : "running", jobId: job.id, error: null };
  if (input.missing === 0) return { ...base, status: "ready", jobId: null, error: null };
  if (job && (job.state === "failed" || job.state === "aborted")) {
    return { ...base, status: "failed", jobId: job.id, error: job.error?.message ?? "Translating the lines was cancelled." };
  }
  return { ...base, status: unavailable ? "unavailable" : "missing", jobId: null, error: unavailable };
}

export async function enqueueCaptionLineTranslation(engine: Engine, request: CaptionLineTranslationRequest): Promise<number | null> {
  const queued = await enqueueAnalysisComponent(engine, lineTranslationSpec(request.language), lineTranslationKey(request.mediaHash, request.language, request.sources), {
    bookId: request.bookId,
    sourceArtifactId: request.artifactId,
    mediaHash: request.mediaHash,
    language: request.language,
    sourceLanguage: request.sourceLanguage,
    sources: request.sources,
    edited: request.edited,
  }, { force: request.force, hasResult: false });
  return queued.jobId;
}

function sourceName(language: string | null): string {
  return language ? subtitleLanguageName(language) : "the spoken language";
}

function lineInstructions(input: CaptionLineTranslationInput, keeps: boolean): string {
  return [
    "You translate the subtitles of one short video.",
    "The user message lists every subtitle line in spoken order as JSON. Each line is one phrase shown on screen, and your translation is shown right under it, so a sentence often runs across several lines.",
    `Translate each line from ${sourceName(input.sourceLanguage)} into ${subtitleLanguageName(input.language)}. Keep the meaning of that line, make it read naturally on its own, and keep names, pronouns and terms consistent with the lines around it.`,
    keeps ? "A line that already comes with a translation keeps it: return that translation unchanged." : "",
    `Return ONLY a JSON object {"translations": [...]} with exactly ${input.sources.length} strings: translation i belongs to line i. Do not merge, split, reorder or omit lines. No romanization, notes or text outside the JSON.`,
  ].filter((part) => part.length > 0).join("\n\n");
}

function lineRequest(input: CaptionLineTranslationInput, lines: readonly GivenLine[]): TranslationListRequest {
  const listed = lines.map((line, index) => (line.given === undefined ? { i: index, text: line.source } : { i: index, text: line.source, translation: line.given }));
  return {
    formatName: LINE_TRANSLATION_FORMAT,
    instructions: lineInstructions(input, lines.some((line) => line.given !== undefined)),
    content: `SUBTITLE LINES (JSON):\n${JSON.stringify(listed)}`,
    count: lines.length,
    maxOutputTokens: Math.min(MAX_OUTPUT_TOKENS, 4096 + lines.length * 96),
  };
}

function givenLine(input: CaptionLineTranslationInput, source: string): GivenLine {
  const given = Object.hasOwn(input.edited, source) ? input.edited[source] : input.memory.get(source);
  return { source, given };
}

function storedLines(input: CaptionLineTranslationInput, lines: readonly GivenLine[], fresh: readonly string[]): CaptionLineTranslation["lines"] {
  return lines.flatMap((line, index) => {
    const known = input.memory.get(line.source);
    if (known !== undefined) return [{ source: line.source, text: known }];
    if (Object.hasOwn(input.edited, line.source)) return [];
    return [{ source: line.source, text: fresh[index] ?? "" }];
  });
}

export async function translateCaptionLines(input: CaptionLineTranslationInput, responses: ResponsesFn, signal?: AbortSignal): Promise<CaptionLineTranslation> {
  const lines = input.sources.map((source) => givenLine(input, source));
  const fresh = lines.some((line) => line.given === undefined)
    ? await requestTranslationList(lineRequest(input, lines), responses, signal)
    : [];
  return { language: input.language, lines: storedLines(input, lines, fresh) };
}
