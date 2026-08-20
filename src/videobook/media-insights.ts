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

export type MediaTranscript = {
  kind: MediaTranscriptKind
  languageCode: string | null
  text: string
  wordCount: number
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

export function asMediaTranscript(value: unknown): MediaTranscript | null {
  const item = recordValue(value)
  const kind = item && transcriptKind(item.kind)
  if (!item || !kind) return null
  return {
    kind,
    languageCode: nonBlankStringValue(item.language_code ?? item.languageCode),
    text: typeof item.text === 'string' ? item.text : '',
    wordCount: wholeNumber(item.word_count ?? item.wordCount),
  }
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
