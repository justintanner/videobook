import { z } from 'zod'
import { captionDocumentSchema, DEFAULT_CAPTION_STYLE } from '../../server/src/captions/model'
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
  document: captionDocumentSchema.optional(),
  regions: z.array(z.object({ time: z.number(), regions: z.array(regionSchema) })).optional(),
  envelope: z.object({ hz: z.number(), values: z.array(z.number()) }).nullable().optional(),
  render: renderSchema.nullable().optional(),
})

export type SubtitlesRead = z.infer<typeof subtitlesReadSchema>
export type SubtitlesRender = z.infer<typeof renderSchema>

export function parseSubtitlesRead(value: unknown): SubtitlesRead {
  return subtitlesReadSchema.parse(value)
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
  return 'Preparing subtitles…'
}

export function activeSubtitleJobIds(read: SubtitlesRead | null): number[] {
  if (!read) return []
  return Object.values(read.components)
    .filter((component) => (component.status === 'queued' || component.status === 'running') && component.job_id !== null)
    .map((component) => component.job_id as number)
}

export function placeholderCaptionDocument(read: SubtitlesRead): CaptionDocument {
  return {
    version: 1,
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

export function subtitlesRenderBlocker(read: SubtitlesRead | null, document: CaptionDocument | null, conflict: boolean): string | null {
  if (!read) return 'Loading subtitles…'
  if (read.status === 'silent') return 'This video has no audio to caption.'
  if (read.status !== 'ready' || !document) return read.message ?? 'Prepare the subtitles first.'
  if (read.draft?.stale_source) return 'The video changed. Realign, keep the timings or discard the edits first.'
  if (conflict) return 'These subtitles changed elsewhere. Reload them or keep your version first.'
  if (!document.words.some((word) => !word.hidden && word.text.trim())) return 'There are no words to render.'
  return null
}
