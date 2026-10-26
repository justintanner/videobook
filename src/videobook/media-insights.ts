import { joinCaptionWords } from '../../server/src/captions/script'
import { nonBlankStringValue, recordValue } from './value-decoders'

type MediaTranscriptKind = 'timed' | 'plain' | 'silence'

/** The two insights an asset can carry, each produced by its own job. */
export type MediaInsightKind = 'transcript' | 'analysis'

/** Per-artifact progress for the inspector's transcribe / analyze actions. */
export type MediaInsightWork = {
  transcribing: boolean
  analyzing: boolean
  error: string | null
}

export const idleMediaInsightWork: MediaInsightWork = {
  transcribing: false,
  analyzing: false,
  error: null,
}

export function mediaInsightIsRunning(
  work: MediaInsightWork,
  insight: MediaInsightKind,
): boolean {
  return insight === 'transcript' ? work.transcribing : work.analyzing
}

export function mediaInsightRunningPatch(
  insight: MediaInsightKind,
  running: boolean,
): Partial<MediaInsightWork> {
  return insight === 'transcript'
    ? { transcribing: running }
    : { analyzing: running }
}

type TimedTranscriptWord = {
  text: string
  start: number
  end: number
}

export type MediaTranscript = {
  kind: MediaTranscriptKind
  languageCode: string | null
  text: string
  wordCount: number
  words: TimedTranscriptWord[]
}

export type MediaTranscriptSources = {
  elevenlabs: MediaTranscript | null
  plain: MediaTranscript | null
}

/** Sidecar identity passed to `read_transcript` when loading raw JSON. */
export type TranscriptSidecarSource = 'plain' | 'elevenlabs'

export type TranscriptCardView = 'text' | 'json'

export const PLAIN_TRANSCRIPT_CARD_TITLE = 'GPT-4o Translation'
export const ELEVENLABS_TRANSCRIPT_CARD_TITLE = 'ElevenLabs Transcript'

export type MediaVisionAnalysis = {
  summary: string
  mood: string | null
  setting: string | null
  tags: string[]
  subjects: string[]
  sceneCount: number
}

function transcriptKind(value: unknown): MediaTranscriptKind | null {
  return value === 'timed' || value === 'plain' || value === 'silence'
    ? value
    : null
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
      const text = nonBlankStringValue(entry)
      return text ? [text] : []
    })
    : []
}

function wholeNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0
}

function timedWords(value: unknown): TimedTranscriptWord[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    const item = recordValue(entry)
    if (!item || typeof item.text !== 'string') return []
    if (typeof item.start !== 'number' || !Number.isFinite(item.start)) return []
    if (typeof item.end !== 'number' || !Number.isFinite(item.end)) return []
    return [{ text: item.text, start: item.start, end: item.end }]
  })
}

export function asMediaTranscript(value: unknown): MediaTranscript | null {
  const item = recordValue(value)
  const kind = item && transcriptKind(item.kind)
  if (!item || !kind) return null
  return {
    kind,
    languageCode: nonBlankStringValue(item.language_code ?? item.languageCode),
    text: typeof item.text === 'string' ? item.text : '',
    wordCount: wholeNumber(item.word_count ?? item.wordCount),
    words: timedWords(item.words),
  }
}

export function asMediaTranscriptSources(
  value: unknown,
): MediaTranscriptSources | null {
  const item = recordValue(value)
  if (!item) return null
  if ('elevenlabs' in item || 'plain' in item) {
    const elevenlabs = asMediaTranscript(item.elevenlabs)
    const plain = asMediaTranscript(item.plain)
    if (!elevenlabs && !plain) return null
    return { elevenlabs, plain }
  }
  const single = asMediaTranscript(item)
  if (!single) return null
  return single.kind === 'plain'
    ? { elevenlabs: null, plain: single }
    : { elevenlabs: single, plain: null }
}

export function asMediaVisionAnalysis(value: unknown): MediaVisionAnalysis | null {
  const item = recordValue(value)
  if (!item) return null
  return {
    summary: typeof item.summary === 'string' ? item.summary : '',
    mood: nonBlankStringValue(item.mood),
    setting: nonBlankStringValue(item.setting),
    tags: stringList(item.tags),
    subjects: stringList(item.subjects),
    sceneCount: wholeNumber(item.scene_count ?? item.sceneCount),
  }
}

/** Media kinds that can carry speech, and so can show a transcript. */
export function mediaCellHasSpokenAudio(cellType: string): boolean {
  return cellType === 'video' || cellType === 'audio' || cellType === 'final'
}

export function transcriptHasText(transcript: MediaTranscript | null): boolean {
  return Boolean(transcript && transcript.kind !== 'silence' && transcript.text.trim())
}

export function transcriptDetailLabel(transcript: MediaTranscript): string {
  if (transcript.kind === 'silence') return 'No dialog detected'
  const details = [
    transcript.kind === 'timed' ? 'Word-timed' : 'Plain text',
    `${transcript.wordCount} ${transcript.wordCount === 1 ? 'word' : 'words'}`,
  ]
  if (transcript.languageCode) details.push(transcript.languageCode)
  return details.join(' · ')
}

export function visionAnalysisDetailLabel(
  analysis: MediaVisionAnalysis,
): string | null {
  const details: string[] = []
  if (analysis.sceneCount > 0) {
    details.push(
      `${analysis.sceneCount} ${analysis.sceneCount === 1 ? 'scene' : 'scenes'}`,
    )
  }
  if (analysis.mood) details.push(analysis.mood)
  if (analysis.setting) details.push(analysis.setting)
  return details.length > 0 ? details.join(' · ') : null
}

const CUE_GAP_SECONDS = 0.4
const CUE_MAX_WORDS = 12

function cueText(words: readonly TimedTranscriptWord[]): string {
  return joinCaptionWords(words.map((item) => item.text.replace(/\s+/g, ' ').trim()))
}

function cuesFromTimedWords(
  words: readonly TimedTranscriptWord[],
): { start: number; text: string }[] {
  const cues: { start: number; text: string }[] = []
  let current: TimedTranscriptWord[] = []
  for (const word of words) {
    const last = current.at(-1)
    const gap = last ? word.start - last.end : 0
    const sentenceEnd = last ? /[.!?]$/.test(last.text.trim()) : false
    if (
      current.length > 0
      && (gap > CUE_GAP_SECONDS || sentenceEnd || current.length >= CUE_MAX_WORDS)
    ) {
      const text = cueText(current)
      if (text) cues.push({ start: current[0]!.start, text })
      current = []
    }
    current.push(word)
  }
  if (current.length > 0) {
    const text = cueText(current)
    if (text) cues.push({ start: current[0]!.start, text })
  }
  return cues
}

export function formatCueTimestamp(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const secs = total % 60
  return `${minutes}:${String(secs).padStart(2, '0')}`
}

export function formatTranscriptCues(
  words: readonly TimedTranscriptWord[],
): string {
  return cuesFromTimedWords(words)
    .map((cue) => `${formatCueTimestamp(cue.start)}  ${cue.text}`)
    .join('\n')
}

export function resolveTranscriptCardView(
  transcript: MediaTranscript | null,
  requested: TranscriptCardView | null,
): TranscriptCardView {
  if (requested === 'json' && transcript) return 'json'
  return 'text'
}

function sourceText(input: {
  source: TranscriptSidecarSource
  transcript: MediaTranscript | null
}): string {
  const transcript = input.transcript
  if (!transcript || transcript.kind === 'silence') return ''
  if (
    input.source === 'elevenlabs'
    && transcript.kind === 'timed'
    && transcript.words.length > 0
  ) {
    return formatTranscriptCues(transcript.words)
  }
  return transcript.text
}

export function transcriptSourceCopyText(input: {
  source: TranscriptSidecarSource
  transcript: MediaTranscript | null
  view: TranscriptCardView
  jsonText: string | null
}): string {
  if (input.view === 'json') return input.jsonText ?? ''
  return sourceText(input)
}

export function transcriptSourceBody(input: {
  source: TranscriptSidecarSource
  transcript: MediaTranscript | null
  view: TranscriptCardView
  jsonText: string | null
}): string {
  return transcriptSourceCopyText(input)
}

export function transcriptSourceMeta(input: {
  transcript: MediaTranscript | null
  view: TranscriptCardView
  jsonFile: string | null
}): string | null {
  if (input.view === 'json') {
    return input.jsonFile ? `Raw sidecar · ${input.jsonFile}` : 'Raw sidecar'
  }
  return input.transcript ? transcriptDetailLabel(input.transcript) : null
}

export function transcriptSourceEmptyMessage(input: {
  source: TranscriptSidecarSource
  transcript: MediaTranscript | null
  view: TranscriptCardView
  jsonLoading: boolean
  jsonError: string | null
  body: string
}): string | null {
  if (input.view === 'json' && input.jsonLoading) return 'Loading sidecar…'
  if (input.view === 'json' && input.jsonError) return input.jsonError
  if (input.transcript?.kind === 'silence') {
    return 'This clip has a transcript but no spoken dialog.'
  }
  if (input.body) return null
  return input.source === 'plain'
    ? 'No GPT-4o translation yet.'
    : 'No transcript yet.'
}

export function canDownloadTranscriptSrt(
  elevenlabs: MediaTranscript | null,
): boolean {
  return elevenlabs?.kind === 'timed'
}
