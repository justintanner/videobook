import { nonBlankStringValue, recordValue } from './value-decoders'

export type MediaTranscriptKind = 'timed' | 'plain' | 'silence'

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

export type TimedTranscriptWord = {
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

export type TranscriptTabId = 'elevenlabs' | 'prompt' | 'json'

export type TranscriptTabState = {
  id: TranscriptTabId
  label: string
  enabled: boolean
  disabledReason: string | null
}

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

/** Media kinds the vision analyzer can describe from sampled frames. */
export function mediaCellIsAnalyzableVideo(cellType: string): boolean {
  return cellType === 'video' || cellType === 'final'
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

export function cuesFromTimedWords(
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
      const text = current.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim()
      if (text) cues.push({ start: current[0]!.start, text })
      current = []
    }
    current.push(word)
  }
  if (current.length > 0) {
    const text = current.map((item) => item.text).join(' ').replace(/\s+/g, ' ').trim()
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

export function transcriptTabStates(
  sources: MediaTranscriptSources | null,
): TranscriptTabState[] {
  const hasElevenlabs = Boolean(sources?.elevenlabs)
  const hasPlain = Boolean(sources?.plain)
  return [
    {
      id: 'elevenlabs',
      label: 'ELEVENLABS',
      enabled: hasElevenlabs,
      disabledReason: hasElevenlabs ? null : 'No ElevenLabs transcript',
    },
    {
      id: 'prompt',
      label: 'PROMPT',
      enabled: hasPlain,
      disabledReason: hasPlain ? null : 'No gpt-4o transcription',
    },
    {
      id: 'json',
      label: 'JSON',
      enabled: hasElevenlabs || hasPlain,
      disabledReason: hasElevenlabs || hasPlain ? null : 'No transcript sidecar',
    },
  ]
}

export function resolveTranscriptTab(
  sources: MediaTranscriptSources | null,
  requested: TranscriptTabId | null,
): TranscriptTabId {
  const enabled = new Set(
    transcriptTabStates(sources)
      .filter((tab) => tab.enabled)
      .map((tab) => tab.id),
  )
  if (requested && enabled.has(requested)) return requested
  if (enabled.has('elevenlabs')) return 'elevenlabs'
  if (enabled.has('prompt')) return 'prompt'
  return 'json'
}

export function transcriptTabCopyText(input: {
  tab: TranscriptTabId
  sources: MediaTranscriptSources | null
  jsonText: string | null
}): string {
  if (input.tab === 'json') return input.jsonText ?? ''
  if (input.tab === 'prompt') return input.sources?.plain?.text ?? ''
  const timed = input.sources?.elevenlabs
  if (!timed) return ''
  if (timed.kind === 'timed' && timed.words.length > 0) {
    return formatTranscriptCues(timed.words)
  }
  return timed.text
}

export function transcriptTabBody(input: {
  tab: TranscriptTabId
  sources: MediaTranscriptSources | null
  jsonText: string | null
}): string {
  return transcriptTabCopyText(input)
}

export function transcriptTabMeta(
  tab: TranscriptTabId,
  sources: MediaTranscriptSources | null,
  jsonFile: string | null,
): string | null {
  if (tab === 'json') {
    return jsonFile ? `Raw sidecar · ${jsonFile}` : 'Raw sidecar'
  }
  const source = tab === 'prompt' ? sources?.plain : sources?.elevenlabs
  return source ? transcriptDetailLabel(source) : null
}

export function canDownloadTranscriptSrt(
  sources: MediaTranscriptSources | null,
): boolean {
  return sources?.elevenlabs?.kind === 'timed'
}

export function sourcesHaveTranscriptText(
  sources: MediaTranscriptSources | null,
): boolean {
  return transcriptHasText(sources?.elevenlabs ?? null)
    || transcriptHasText(sources?.plain ?? null)
}

export function sourcesAreSilenceOnly(
  sources: MediaTranscriptSources | null,
): boolean {
  if (!sources) return false
  const present = [sources.elevenlabs, sources.plain].filter(Boolean)
  return present.length > 0 && present.every((item) => item?.kind === 'silence')
}
