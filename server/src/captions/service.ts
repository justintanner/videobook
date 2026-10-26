import { createHash } from "node:crypto";
import type { Engine } from "videobook-engine";
import type { AnalysisComponentState } from "../analysis-components.js";
import { missingFrameTimes } from "../frame-regions.js";
import { iso1FromIso3 } from "../jobs/_translate-transcript.js";
import { withNotebookMutation } from "../notebook-mutations.js";
import { parseSegments } from "../remotion/subtitles/segments.js";
import type { CaptionAnalysisState, CaptionComponentName, CaptionRegions, CaptionTranslation, CaptionVocal } from "./analysis.js";
import {
  captionAnalysisStateFor,
  captionTranslationState,
  prepareCaptionAnalysis,
  readCaptionTranscript,
  regionFrameRequests,
} from "./analysis.js";
import type { CaptionDraft } from "./drafts.js";
import { deleteCaptionDraft, readCaptionDraft, writeCaptionDraft } from "./drafts.js";
import type { CaptionEdit } from "./edits.js";
import { applyCaptionEdits, captionDocumentProblems, CaptionEditError } from "./edits.js";
import { LEGACY_ALIVE_SETTINGS_KEY, styleFromLegacyAliveSettings } from "./legacy.js";
import type { CaptionAspect, CaptionDocument, CaptionStyle } from "./model.js";
import { captionDocumentSchema, DEFAULT_CAPTION_STYLE, ORIGINAL_CAPTION_LANGUAGE } from "./model.js";
import type { CaptionSeedWord } from "./seed.js";
import { reseedCaptionDocument, seedCaptionDocument } from "./seed.js";
import type { CaptionMediaSource } from "./source.js";
import { captionMediaSource } from "./source.js";
import { ensureCaptionVocalTiming } from "./vocal.js";

export type CaptionReadStatus = "ready" | "preparing" | "needs_prepare" | "unavailable" | "failed" | "silent";
export type CaptionResolution = "reseed" | "realign" | "keep_timings" | "discard";
export type CaptionServiceErrorCode = "conflict" | "not_ready" | "invalid" | "stale_source";

export class CaptionServiceError extends Error {
  readonly code: CaptionServiceErrorCode;
  readonly revision: string | null;

  constructor(code: CaptionServiceErrorCode, message: string, revision: string | null = null) {
    super(message);
    this.code = code;
    this.revision = revision;
  }
}

interface ComponentSummary {
  status: string;
  job_id: number | null;
  error: string | null;
  provenance: AnalysisComponentState<unknown>["provenance"];
}

interface PaidWork {
  component: CaptionComponentName;
  provider: "elevenlabs" | "openai";
  description: string;
  usd: number | null;
}

export interface CaptionDraftSummary {
  revision: string;
  saved: boolean;
  updated_at: string | null;
  stale_source: boolean;
  analysis_newer: boolean;
  word_count: number;
  phrase_count: number;
  corrected_words: number;
  word_timing: CaptionDocument["wordTiming"];
}

export interface CaptionReadModel {
  asset_id: string;
  language: string;
  status: CaptionReadStatus;
  message: string | null;
  source: {
    media_hash: string;
    duration_seconds: number;
    width: number;
    height: number;
    fps: number;
    has_audio: boolean;
    label: string | null;
  };
  components: Record<string, ComponentSummary>;
  paid_work: PaidWork[];
  draft: CaptionDraftSummary | null;
  document?: CaptionDocument;
  regions?: CaptionRegions["frames"];
  envelope?: { hz: number; values: number[] } | null;
}

interface DraftContext {
  source: CaptionMediaSource;
  analysis: CaptionAnalysisState;
  translation: AnalysisComponentState<CaptionTranslation> | null;
  status: CaptionReadStatus;
  message: string | null;
  saved: CaptionDraft | null;
  seed: { revision: string; document: CaptionDocument } | null;
}

function summary<T>(state: AnalysisComponentState<T> | null): ComponentSummary | null {
  return state ? { status: state.status, job_id: state.jobId, error: state.error, provenance: state.provenance } : null;
}

function componentStatusFor(state: AnalysisComponentState<unknown>): { status: CaptionReadStatus; message: string | null } | null {
  if (state.status === "queued" || state.status === "running") return { status: "preparing", message: null };
  if (state.status === "failed") return { status: "failed", message: state.error };
  if (state.status === "unavailable") return { status: "unavailable", message: state.error };
  if (state.status === "missing") return { status: "needs_prepare", message: null };
  return null;
}

function overallStatus(analysis: CaptionAnalysisState, translation: AnalysisComponentState<CaptionTranslation> | null, language: string): { status: CaptionReadStatus; message: string | null } {
  const transcript = analysis.transcript;
  if (transcript.status === "queued" || transcript.status === "running") return { status: "preparing", message: null };
  if (transcript.status === "failed") return { status: "failed", message: transcript.error };
  if (transcript.status === "unavailable") return { status: "unavailable", message: transcript.error };
  if (transcript.status === "missing") return { status: "needs_prepare", message: null };
  if (transcript.silent) return { status: "silent", message: "This video has no audio to caption." };
  const pending = analysis.vocal ? componentStatusFor(analysis.vocal) : null;
  if (pending) return pending;
  if (language !== ORIGINAL_CAPTION_LANGUAGE && translation) {
    const translated = componentStatusFor(translation);
    if (translated) return translated;
  }
  return { status: "ready", message: null };
}

function clock(seconds: number): string {
  const whole = Math.max(0, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function paidWork(context: Pick<DraftContext, "source" | "analysis" | "translation">, language: string, regionFrames: number | null): PaidWork[] {
  const work: PaidWork[] = [];
  const { analysis, source } = context;
  if (analysis.transcript.status === "missing" || analysis.transcript.status === "failed") {
    work.push({ component: "transcript", provider: "elevenlabs", description: `Transcribe ${clock(source.durationSeconds)} of audio with ElevenLabs`, usd: null });
  }
  if (analysis.regions && regionFrames !== 0 && (analysis.regions.status === "missing" || analysis.regions.status === "failed")) {
    work.push({ component: "regions", provider: "openai", description: `Check ${regionFrames ?? "each phrase's"} frames for faces and on-screen text with OpenAI`, usd: null });
  }
  if (language !== ORIGINAL_CAPTION_LANGUAGE && (!context.translation || context.translation.status === "missing" || context.translation.status === "failed")) {
    work.push({ component: "translation", provider: "openai", description: `Translate the transcript into ${language} with OpenAI`, usd: null });
  }
  return work;
}

async function legacyStyle(engine: Engine, artifactId: string): Promise<Partial<CaptionStyle>> {
  const saved = await engine.metadata.artifacts.read<unknown>(artifactId, LEGACY_ALIVE_SETTINGS_KEY);
  return saved.ok ? styleFromLegacyAliveSettings(saved.value) : {};
}

function vocalWords(transcript: Awaited<ReturnType<typeof readCaptionTranscript>>, vocal: CaptionVocal | null): CaptionSeedWord[] {
  return (transcript?.words ?? []).map((word, index) => ({
    text: word.text,
    start: word.start,
    end: word.end,
    onset: vocal?.words[index]?.onset ?? word.start,
    energy: vocal?.words[index]?.energy ?? 0.5,
    speaker: word.speaker,
  }));
}

async function translatedWords(engine: Engine, artifactId: string, translation: CaptionTranslation): Promise<CaptionSeedWord[] | null> {
  const read = await engine.files.read(artifactId, translation.file);
  if (!read.ok) return null;
  try {
    const segments = parseSegments(JSON.parse(read.value.toString()) as Parameters<typeof parseSegments>[0]);
    return segments.flatMap((segment) => segment.words.map((word) => ({
      text: word.word,
      start: word.start,
      end: word.end,
      onset: word.start,
      energy: 0.5,
      speaker: null,
    })));
  } catch {
    return null;
  }
}

function sourceFields(source: CaptionMediaSource): CaptionDocument["source"] {
  return {
    artifactId: source.artifactId,
    mediaHash: source.mediaHash,
    durationSeconds: source.durationSeconds,
    width: source.width,
    height: source.height,
    fps: source.fps,
  };
}

async function buildSeed(engine: Engine, context: Omit<DraftContext, "seed" | "saved">, language: string): Promise<{ revision: string; document: CaptionDocument } | null> {
  if (context.status !== "ready") return null;
  const transcript = await readCaptionTranscript(engine, context.source);
  if (!transcript) return null;
  const vocal = context.analysis.vocal?.value ?? null;
  const translated = language === ORIGINAL_CAPTION_LANGUAGE || !context.translation?.value
    ? null
    : await translatedWords(engine, context.source.artifactId, context.translation.value);
  if (language !== ORIGINAL_CAPTION_LANGUAGE && !translated) return null;
  const style = { ...DEFAULT_CAPTION_STYLE, ...(await legacyStyle(engine, context.source.artifactId)) };
  const bindings = {
    transcriptKey: transcript.hash,
    vocalKey: context.analysis.vocal?.key ?? null,
    translationKey: language === ORIGINAL_CAPTION_LANGUAGE ? null : context.translation?.key ?? null,
  };
  const document = seedCaptionDocument({
    source: sourceFields(context.source),
    bindings,
    language,
    sourceLanguage: iso1FromIso3(transcript.language) ?? transcript.language,
    wordTiming: translated ? "estimated" : "measured",
    words: translated ?? vocalWords(transcript, vocal),
    style,
  });
  const revision = `seed:${createHash("sha256").update(JSON.stringify(document)).digest("hex").slice(0, 32)}`;
  return { revision, document };
}

async function draftContext(engine: Engine, artifactId: string, language: string): Promise<DraftContext> {
  const source = await captionMediaSource(engine, artifactId);
  const analysis = captionAnalysisStateFor(engine, source);
  const translation = language === ORIGINAL_CAPTION_LANGUAGE ? null : captionTranslationState(engine, source, analysis.transcript, language);
  const { status, message } = overallStatus(analysis, translation, language);
  const base = { source, analysis, translation, status, message };
  const saved = readCaptionDraft(engine, artifactId, language);
  return { ...base, saved, seed: await buildSeed(engine, base, language) };
}

function correctedCount(document: CaptionDocument): number {
  return document.words.filter((word) => word.textCorrected || word.timingCorrected || word.hidden || word.analysed === null).length;
}

function analysisNewer(context: DraftContext): boolean {
  if (!context.saved || !context.seed) return false;
  const current = context.seed.document.bindings;
  const draft = context.saved.document.bindings;
  return current.transcriptKey !== draft.transcriptKey
    || (current.vocalKey !== null && current.vocalKey !== draft.vocalKey)
    || (current.translationKey !== null && current.translationKey !== draft.translationKey);
}

function draftSummary(context: DraftContext): CaptionDraftSummary | null {
  const active = context.saved ?? context.seed;
  if (!active) return null;
  const document = active.document;
  return {
    revision: active.revision,
    saved: context.saved !== null,
    updated_at: context.saved?.updatedAt ?? null,
    stale_source: document.source.mediaHash !== context.source.mediaHash,
    analysis_newer: analysisNewer(context),
    word_count: document.words.filter((word) => !word.hidden).length,
    phrase_count: document.phrases.length,
    corrected_words: correctedCount(document),
    word_timing: document.wordTiming,
  };
}

function readModel(context: DraftContext, language: string, detail: "summary" | "full", regionFrames: number | null): CaptionReadModel {
  const components: Record<string, ComponentSummary> = {
    transcript: { status: context.analysis.transcript.status, job_id: context.analysis.transcript.jobId, error: context.analysis.transcript.error, provenance: null },
  };
  const vocal = summary(context.analysis.vocal);
  const regions = summary(context.analysis.regions);
  const translation = summary(context.translation);
  if (vocal) components.vocal = vocal;
  if (regions) components.regions = regions;
  if (translation) components.translation = translation;
  const model: CaptionReadModel = {
    asset_id: context.source.artifactId,
    language,
    status: context.status,
    message: context.message,
    source: {
      media_hash: context.source.mediaHash,
      duration_seconds: context.source.durationSeconds,
      width: context.source.width,
      height: context.source.height,
      fps: context.source.fps,
      has_audio: context.source.hasAudio,
      label: context.source.label,
    },
    components,
    paid_work: paidWork(context, language, regionFrames),
    draft: draftSummary(context),
  };
  if (detail === "summary") return model;
  const vocalValue = context.analysis.vocal?.value ?? null;
  return {
    ...model,
    ...((context.saved ?? context.seed) ? { document: (context.saved ?? context.seed)!.document } : {}),
    regions: context.analysis.regions?.value?.frames ?? [],
    envelope: vocalValue ? { hz: vocalValue.envelopeHz, values: vocalValue.envelope } : null,
  };
}

async function regionFrameCount(engine: Engine, context: DraftContext): Promise<number | null> {
  if (!context.analysis.regions || context.analysis.regions.status === "ready") return null;
  const transcript = await readCaptionTranscript(engine, context.source);
  if (!transcript) return null;
  const times = regionFrameRequests(transcript.words, context.source.durationSeconds).map((request) => request.time);
  return missingFrameTimes(engine, context.source.mediaHash, times).length;
}

export async function readCaptions(engine: Engine, artifactId: string, language: string, detail: "summary" | "full"): Promise<CaptionReadModel> {
  const context = await draftContext(engine, artifactId, language);
  return readModel(context, language, detail, await regionFrameCount(engine, context));
}

export async function prepareCaptions(
  engine: Engine,
  bookId: string,
  artifactId: string,
  language: string,
  options: { regions: boolean; force: readonly CaptionComponentName[]; detail: "summary" | "full" },
): Promise<CaptionReadModel> {
  await prepareCaptionAnalysis(engine, bookId, artifactId, {
    regions: options.regions,
    languages: language === ORIGINAL_CAPTION_LANGUAGE ? [] : [language],
    force: options.force,
  });
  return readCaptions(engine, artifactId, language, options.detail);
}

export interface CaptionUpdateInput {
  expectedRevision: string;
  document?: unknown;
  edits?: readonly CaptionEdit[];
  resolve?: CaptionResolution;
}

export interface CaptionUpdateResult {
  revision: string;
  saved: boolean;
  document: CaptionDocument | null;
  reseed: { kept: number; unplaced: number; shift_seconds: number } | null;
}

function replacementDocument(current: CaptionDocument, value: unknown): CaptionDocument {
  const parsed = captionDocumentSchema.safeParse(value);
  if (!parsed.success) {
    throw new CaptionServiceError("invalid", `Invalid subtitle document: ${parsed.error.issues.slice(0, 3).map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`);
  }
  const next = parsed.data;
  if (JSON.stringify(next.source) !== JSON.stringify(current.source) || JSON.stringify(next.bindings) !== JSON.stringify(current.bindings) || next.language !== current.language) {
    throw new CaptionServiceError("invalid", "The document's source, analysis bindings and language cannot be changed by an update; use resolve instead.");
  }
  const problems = captionDocumentProblems(next);
  if (problems.length > 0) throw new CaptionServiceError("invalid", problems[0]);
  return next;
}

function requireFreshSeed(context: DraftContext): CaptionDocument {
  if (!context.seed) throw new CaptionServiceError("not_ready", "Prepare the subtitles for the current video before updating them from its analysis.");
  return context.seed.document;
}

function keepTimings(current: CaptionDocument, context: DraftContext): CaptionDocument {
  const rebound: CaptionDocument = {
    ...current,
    source: sourceFields(context.source),
    bindings: context.seed?.document.bindings ?? current.bindings,
  };
  const problems = captionDocumentProblems(rebound);
  if (problems.length > 0) throw new CaptionServiceError("invalid", `${problems[0]} Realign the subtitles instead.`);
  return rebound;
}

function resolveDocument(current: CaptionDocument, context: DraftContext, resolve: Exclude<CaptionResolution, "discard">) {
  const stale = current.source.mediaHash !== context.source.mediaHash;
  if (resolve === "reseed") {
    if (stale) throw new CaptionServiceError("stale_source", "The video changed. Realign or keep the timings first.");
    const result = reseedCaptionDocument(current, requireFreshSeed(context), { realign: false });
    return { document: result.document, reseed: { kept: result.kept, unplaced: result.unplaced, shift_seconds: result.shiftSeconds } };
  }
  if (!stale) throw new CaptionServiceError("invalid", "The video has not changed since these subtitles were edited.");
  if (resolve === "keep_timings") return { document: keepTimings(current, context), reseed: null };
  const result = reseedCaptionDocument(current, requireFreshSeed(context), { realign: true });
  return { document: result.document, reseed: { kept: result.kept, unplaced: result.unplaced, shift_seconds: result.shiftSeconds } };
}

function nextDocument(current: CaptionDocument, context: DraftContext, input: CaptionUpdateInput) {
  if (input.resolve && input.resolve !== "discard") return resolveDocument(current, context, input.resolve);
  if (current.source.mediaHash !== context.source.mediaHash) {
    throw new CaptionServiceError("stale_source", "The video changed since these subtitles were edited. Realign, keep the timings or discard the edits.");
  }
  if (input.document !== undefined) return { document: replacementDocument(current, input.document), reseed: null };
  try {
    return { document: applyCaptionEdits(current, input.edits ?? []), reseed: null };
  } catch (error) {
    if (error instanceof CaptionEditError) throw new CaptionServiceError("invalid", error.message);
    throw error;
  }
}

export async function updateCaptions(
  engine: Engine,
  bookId: string,
  artifactId: string,
  language: string,
  input: CaptionUpdateInput,
): Promise<CaptionUpdateResult> {
  return withNotebookMutation(`captions:${bookId}:${artifactId}:${language}`, async () => {
    const context = await draftContext(engine, artifactId, language);
    const current = context.saved ?? context.seed;
    if (!current) throw new CaptionServiceError("not_ready", context.message ?? "Prepare the subtitles before editing them.");
    if (current.revision !== input.expectedRevision) {
      throw new CaptionServiceError("conflict", "These subtitles changed somewhere else. Reload them before editing.", current.revision);
    }
    if (input.resolve === "discard") {
      deleteCaptionDraft(engine, artifactId, language);
      return { revision: context.seed?.revision ?? "none", saved: false, document: context.seed?.document ?? null, reseed: null };
    }
    const next = nextDocument(current.document, context, input);
    const draft = writeCaptionDraft(engine, artifactId, language, next.document);
    return { revision: draft.revision, saved: true, document: draft.document, reseed: next.reseed };
  });
}

export async function savedCaptionDraft(engine: Engine, bookId: string, artifactId: string, language: string, expectedRevision: string): Promise<CaptionDraft> {
  return withNotebookMutation(`captions:${bookId}:${artifactId}:${language}`, async () => {
    const context = await draftContext(engine, artifactId, language);
    const current = context.saved ?? context.seed;
    if (!current) throw new CaptionServiceError("not_ready", context.message ?? "Prepare the subtitles before rendering them.");
    if (current.revision !== expectedRevision) {
      throw new CaptionServiceError("conflict", "These subtitles changed after review. Review the latest version, then render.", current.revision);
    }
    if (current.document.source.mediaHash !== context.source.mediaHash) {
      throw new CaptionServiceError("stale_source", "The video changed since these subtitles were edited. Realign, keep the timings or discard the edits before rendering.");
    }
    return context.saved ?? writeCaptionDraft(engine, artifactId, language, current.document);
  });
}

export async function captionDocumentForRender(
  engine: Engine,
  artifactId: string,
  aspect: CaptionAspect,
  signal: AbortSignal,
): Promise<{ document: CaptionDocument; regions: CaptionRegions["frames"] } | null> {
  const source = await captionMediaSource(engine, artifactId);
  await ensureCaptionVocalTiming(engine, source, signal);
  const context = await draftContext(engine, artifactId, ORIGINAL_CAPTION_LANGUAGE);
  const saved = context.saved && context.saved.document.source.mediaHash === source.mediaHash ? context.saved.document : null;
  const document = saved ?? context.seed?.document ?? null;
  if (!document) return null;
  return { document: { ...document, aspect }, regions: context.analysis.regions?.value?.frames ?? [] };
}
