import { z } from 'zod'
import { captionTranslationLanguages, missingCaptionLines, resolveCaptionTranslations, resolvedCaptionLines } from '../../server/src/captions/lines'
import type { CaptionLineMemory } from '../../server/src/captions/lines'
import { CAPTION_DOCUMENT_VERSION, captionDocumentSchema, DEFAULT_CAPTION_STYLE } from '../../server/src/captions/model'
import type { CaptionDocument, CaptionWord } from '../../server/src/captions/model'
import { effectiveWordTiming } from '../../server/src/captions/timing'

const componentSchema = z.object({
  status: z.string(),
  job_id: z.number().nullable(),
  error: z.string().nullable(),
}).passthrough()

const renderSchema = z.object({
  request_id: z.string(),
  status: z.enum(['queued', 'running', 'completed', 'failed']),
  job_id: z.number().nullable(),
  output_asset_id: z.string(),
  cell_id: z.string().nullable(),
  address: z.string().nullable(),
  error: z.string().nullable(),
})

const translationStatusSchema = z.enum(['missing', 'queued', 'running', 'ready', 'failed', 'unavailable'])

const translationSchema = z.object({
  language: z.string(),
  status: translationStatusSchema,
  available: z.boolean(),
  job_id: z.number().nullable(),
  error: z.string().nullable(),
  missing_lines: z.number(),
})

const regionSchema = z.object({
  kind: z.enum(['face', 'text', 'graphic']),
  confidence: z.number(),
  x: z.number(),
  y: z.number(),
  width: z.number(),
  height: z.number(),
})

export const subtitlesReadSchema = z.object({
  asset_id: z.string(),
  language: z.string(),
  status: z.enum(['ready', 'preparing', 'needs_prepare', 'unavailable', 'failed', 'silent']),
  message: z.string().nullable(),
  source: z.object({
    media_hash: z.string(),
    duration_seconds: z.number(),
    width: z.number(),
    height: z.number(),
    fps: z.number(),
    has_audio: z.boolean(),
    label: z.string().nullable(),
  }),
  components: z.record(z.string(), componentSchema),
  paid_work: z.array(z.object({ component: z.string(), provider: z.string(), description: z.string(), usd: z.number().nullable() })),
  draft: z.object({
    revision: z.string(),
    saved: z.boolean(),
    updated_at: z.string().nullable(),
    stale_source: z.boolean(),
    analysis_newer: z.boolean(),
    word_count: z.number(),
    phrase_count: z.number(),
    corrected_words: z.number(),
    word_timing: z.enum(['measured', 'estimated']),
  }).nullable(),
  translations: z.array(translationSchema).default([]),
  document: captionDocumentSchema.optional(),
  translation_memory: z.record(z.string(), z.record(z.string(), z.string())).optional(),
  regions: z.array(z.object({ time: z.number(), regions: z.array(regionSchema) })).optional(),
  envelope: z.object({ hz: z.number(), values: z.array(z.number()) }).nullable().optional(),
  render: renderSchema.nullable().optional(),
  graphics_revision: z.string().nullable().optional(),
})

export type SubtitlesRead = z.infer<typeof subtitlesReadSchema>
export type SubtitlesRender = z.infer<typeof renderSchema>
export type SubtitleTranslationStatus = z.infer<typeof translationSchema>

const NO_LINES: CaptionLineMemory = {}

export function subtitleLineMemory(read: SubtitlesRead | null): CaptionLineMemory {
  return read?.translation_memory ?? NO_LINES
}

export function resolvedSubtitleDocument(document: CaptionDocument, read: SubtitlesRead | null): CaptionDocument {
  return resolveCaptionTranslations(document, subtitleLineMemory(read))
}

export interface SubtitleLineProgress {
  language: string
  missing: number
  status: SubtitleTranslationStatus['status'] | null
  available: boolean
  error: string | null
}

export function subtitleLineProgress(read: SubtitlesRead | null, document: CaptionDocument): SubtitleLineProgress[] {
  const memory = subtitleLineMemory(read)
  return captionTranslationLanguages(document).map((language) => {
    const server = read?.translations.find((translation) => translation.language === language) ?? null
    return {
      language,
      missing: missingCaptionLines(document, language, memory).length,
      status: server?.status ?? null,
      available: server?.available ?? true,
      error: server?.error ?? null,
    }
  })
}

export interface SubtitlePhraseLine {
  language: string
  text: string | null
  edited: boolean
}

const NO_PHRASE_LINES: SubtitlePhraseLine[] = []

export function subtitlePhraseLines(document: CaptionDocument, memory: CaptionLineMemory): Map<string, SubtitlePhraseLine[]> {
  const byPhrase = new Map<string, SubtitlePhraseLine[]>()
  for (const language of captionTranslationLanguages(document)) {
    for (const line of resolvedCaptionLines(document, language, memory)) {
      byPhrase.set(line.phraseId, [...(byPhrase.get(line.phraseId) ?? NO_PHRASE_LINES), { language, text: line.text, edited: line.edited }])
    }
  }
  return byPhrase
}

export function phraseLinesOf(lines: ReadonlyMap<string, SubtitlePhraseLine[]>, phraseId: string): SubtitlePhraseLine[] {
  return lines.get(phraseId) ?? NO_PHRASE_LINES
}

function translating(read: SubtitlesRead | null): boolean {
  return Boolean(read?.translations.some((translation) => translation.status === 'queued' || translation.status === 'running'))
}

export function subtitleReadLacksLanguages(read: SubtitlesRead | null, document: CaptionDocument): boolean {
  const known = new Set(read?.translations.map((translation) => translation.language) ?? [])
  return captionTranslationLanguages(document).some((language) => !known.has(language))
}

function subtitleLinesNeedTranslation(read: SubtitlesRead | null, document: CaptionDocument | null): boolean {
  if (!document) return false
  return subtitleLineProgress(read, document).some((line) => line.missing > 0 && line.available)
}

export function parseSubtitlesRead(value: unknown): SubtitlesRead {
  return subtitlesReadSchema.parse(value)
}

export type SubtitleRenderOutput = 'new' | 'replace'

export function subtitlesRenderQueuedMessage(output: SubtitleRenderOutput, target: { label: string; address: string | null }): string {
  const name = target.address ? `@${target.address}` : target.label
  return output === 'replace'
    ? `Burning subtitles into ${name}. The video updates in place when the render finishes.`
    : `Rendering subtitles for ${name}. The subtitled copy appears below it when the render finishes.`
}

export function parseSubtitlesRender(value: unknown): SubtitlesRender {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>).render : null
  return renderSchema.parse(record)
}

export interface SubtitlesToolError {
  status: string
  message: string
  revision: string | null
}

export function subtitlesToolError(error: unknown): SubtitlesToolError {
  const text = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>
    return {
      status: typeof parsed.status === 'string' ? parsed.status : 'error',
      message: typeof parsed.message === 'string' ? parsed.message : text,
      revision: typeof parsed.revision === 'string' ? parsed.revision : null,
    }
  } catch {
    return { status: 'error', message: text, revision: null }
  }
}

const ARTIFACT_REFERENCE = /^@?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/iu
const GRID_REFERENCE = /^@[a-z]{1,2}\d{1,2}$/iu

export function subtitlesCommandTarget(rest: string): string | null {
  const first = rest.trim().split(/\s+/u)[0] ?? ''
  const artifact = ARTIFACT_REFERENCE.exec(first)
  if (artifact) return artifact[1]
  return GRID_REFERENCE.test(first) ? first : null
}

export function formatCaptionTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  return `${minutes}:${rest.toFixed(2).padStart(5, '0')}`
}

export interface SubtitlePhraseRow {
  id: string
  index: number
  start: number
  end: number
  words: CaptionWord[]
}

export function subtitlePhraseRows(document: CaptionDocument): SubtitlePhraseRow[] {
  const byId = new Map(document.words.map((word) => [word.id, word]))
  return document.phrases.map((phrase, index) => {
    const words = phrase.wordIds.map((id) => byId.get(id)).filter((word): word is CaptionWord => Boolean(word))
    const visible = words.filter((word) => !word.hidden)
    const timed = (visible.length > 0 ? visible : words).map((word) => effectiveWordTiming(word, document.style))
    return {
      id: phrase.id,
      index,
      start: timed[0]?.start ?? 0,
      end: timed[timed.length - 1]?.end ?? 0,
      words,
    }
  })
}

export function activeSubtitleWordId(document: CaptionDocument, time: number): string | null {
  let active: string | null = null
  for (const word of document.words) {
    if (word.hidden) continue
    const timing = effectiveWordTiming(word, document.style)
    if (timing.start <= time && time < timing.end) active = word.id
    if (timing.start > time) break
  }
  return active
}

export function phraseOfWord(document: CaptionDocument, wordId: string): string | null {
  return document.phrases.find((phrase) => phrase.wordIds.includes(wordId))?.id ?? null
}

export function isCorrectedWord(word: CaptionWord): boolean {
  return word.textCorrected || word.timingCorrected || word.hidden || word.analysed === null
}

export function subtitlesPreparationLabel(read: SubtitlesRead): string {
  const running = Object.entries(read.components)
    .filter(([, component]) => component.status === 'queued' || component.status === 'running')
    .map(([name]) => name)
  if (running.includes('transcript')) return 'Transcribing speech…'
  if (running.includes('translation')) return 'Translating…'
  if (running.includes('vocal')) return 'Measuring vocal timing…'
  if (running.includes('regions')) return 'Finding faces and on-screen text…'
  if (translating(read)) return 'Translating lines…'
  return 'Preparing subtitles…'
}

export function subtitlesBusy(read: SubtitlesRead | null): boolean {
  if (!read) return false
  return read.status === 'preparing'
    || Object.values(read.components).some((component) => component.status === 'queued' || component.status === 'running')
    || translating(read)
}

export function activeSubtitleJobIds(read: SubtitlesRead | null): number[] {
  if (!read) return []
  const jobs = [...Object.values(read.components), ...read.translations]
    .filter((component) => component.status === 'queued' || component.status === 'running')
    .map((component) => component.job_id)
  return jobs.filter((jobId): jobId is number => jobId !== null)
}

export function placeholderCaptionDocument(read: SubtitlesRead): CaptionDocument {
  return {
    version: CAPTION_DOCUMENT_VERSION,
    language: read.language,
    sourceLanguage: null,
    wordTiming: 'measured',
    source: {
      artifactId: read.asset_id,
      mediaHash: read.source.media_hash,
      durationSeconds: Math.max(0.1, read.source.duration_seconds),
      width: Math.max(1, read.source.width),
      height: Math.max(1, read.source.height),
      fps: read.source.fps,
    },
    bindings: { transcriptKey: 'pending', vocalKey: null, translationKey: null },
    aspect: '9:16',
    positions: {},
    style: DEFAULT_CAPTION_STYLE,
    words: [],
    phrases: [],
    nextId: 1,
  }
}

export function subtitlesNeedPrepare(read: SubtitlesRead | null, document: CaptionDocument | null): boolean {
  return read?.status === 'needs_prepare' || (read?.status === 'ready' && subtitleLinesNeedTranslation(read, document))
}

export function subtitlesPreparesBeforeRender(read: SubtitlesRead | null, document: CaptionDocument | null = null): boolean {
  return read?.status === 'preparing' || translating(read) || subtitlesNeedPrepare(read, document)
}

export function subtitleLinesProblem(read: SubtitlesRead | null, document: CaptionDocument | null): string | null {
  const stuck = read && document ? subtitleLineProgress(read, document).find((line) => line.missing > 0) : null
  if (!stuck) return null
  return stuck.error ?? `${stuck.missing} translated line${stuck.missing === 1 ? ' is' : 's are'} still missing. Translate them or write them yourself.`
}

export function subtitlesRenderBlocker(read: SubtitlesRead | null, document: CaptionDocument | null, conflict: boolean): string | null {
  if (!read) return 'Loading subtitles…'
  if (read.status === 'silent') return 'This video has no audio to caption.'
  if (subtitlesPreparesBeforeRender(read, document)) return null
  if (read.status !== 'ready' || !document) return read.message ?? 'Prepare the subtitles first.'
  if (read.draft?.stale_source) return 'The video changed. Realign, keep the timings or discard the edits first.'
  if (conflict) return 'These subtitles changed elsewhere. Reload them or keep your version first.'
  if (!document.words.some((word) => !word.hidden && word.text.trim())) return 'There are no words to render.'
  return subtitleLinesProblem(read, document)
}
