import { aliveAnalysisSchema, aliveSettingsSchema } from '../../server/src/alive-captions/schema'
import type {
  AliveAnalysis,
  AliveCue,
  AliveSettings,
  FrameGeometry,
} from '../../server/src/remotion/subtitles/alive-types'
import { wordTiming } from '../../server/src/remotion/subtitles/alive-layout'

export type AliveOrientation = 'landscape' | 'portrait' | 'square'

export type AliveStudioData = {
  analysis: AliveAnalysis
  settings: AliveSettings
  cached: boolean
}

export const ALIVE_ORIENTATIONS: ReadonlyArray<{ id: AliveOrientation; label: string; width: number; height: number }> = [
  { id: 'landscape', label: '16:9', width: 1920, height: 1080 },
  { id: 'portrait', label: '9:16', width: 1080, height: 1920 },
  { id: 'square', label: '1:1', width: 1080, height: 1080 },
]

/** Onsets closer than this to the transcript time are not reported as drift. */
const DRIFT_SECONDS = 0.03

export function parseAliveStudioData(raw: unknown): AliveStudioData {
  const record = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
  return {
    analysis: aliveAnalysisSchema.parse(record.analysis),
    settings: aliveSettingsSchema.parse(record.settings),
    cached: record.cached === true,
  }
}

export function defaultAliveOrientation(width: number | null, height: number | null): AliveOrientation {
  if (!width || !height) return 'landscape'
  if (height > width) return 'portrait'
  return width === height ? 'square' : 'landscape'
}

export function orientationGeometry(analysis: AliveAnalysis, orientation: AliveOrientation): FrameGeometry {
  const target = ALIVE_ORIENTATIONS.find((option) => option.id === orientation) ?? ALIVE_ORIENTATIONS[0]
  return {
    sourceWidth: analysis.sourceWidth,
    sourceHeight: analysis.sourceHeight,
    targetWidth: target.width,
    targetHeight: target.height,
  }
}

export type AliveWordRow = {
  key: string
  phraseIndex: number
  text: string
  start: number
  end: number
  onset: number
  driftMs: number
  drifted: boolean
}

export function aliveWordRows(analysis: AliveAnalysis, settings: AliveSettings): AliveWordRow[] {
  return analysis.phrases.flatMap((phrase, phraseIndex) => phrase.lines.flat().map((word, index) => {
    const timing = wordTiming(word, settings.snapToOnsets)
    const drift = word.transcriptStart - word.onsetStart
    return {
      key: `${phrase.id}-${index}`,
      phraseIndex,
      text: word.text,
      start: timing.start,
      end: timing.end,
      onset: word.onsetStart,
      driftMs: Math.round(drift * 1000),
      drifted: Math.abs(drift) >= DRIFT_SECONDS,
    }
  }))
}

export function driftRange(rows: AliveWordRow[]): { count: number; minMs: number; maxMs: number } {
  const drifted = rows.filter((row) => row.drifted).map((row) => Math.abs(row.driftMs))
  return {
    count: drifted.length,
    minMs: drifted.length > 0 ? Math.min(...drifted) : 0,
    maxMs: drifted.length > 0 ? Math.max(...drifted) : 0,
  }
}

export function cueIndexAt(cues: AliveCue[], time: number): number {
  return cues.findIndex((cue) => time >= cue.start && time < cue.end)
}

export function placementLabel(cue: AliveCue): string {
  if (cue.column.side === 'center') return 'stack centered'
  return `stack ${cue.column.side}`
}

export function formatAliveTime(seconds: number): string {
  const safe = Math.max(0, seconds)
  const minutes = Math.floor(safe / 60)
  const rest = safe - minutes * 60
  const whole = Math.floor(rest)
  const hundredths = Math.floor((rest - whole) * 100)
  return `${String(minutes).padStart(2, '0')}:${String(whole).padStart(2, '0')}.${String(hundredths).padStart(2, '0')}`
}

/** Filled SVG path (viewBox 0 0 1000 100) of the loudness envelope. */
export function envelopePath(envelope: number[]): string {
  if (envelope.length === 0) return ''
  const step = 1000 / envelope.length
  const points = envelope.map((value, index) => `${(index * step).toFixed(1)},${(100 - value * 100).toFixed(1)}`)
  return `M0,100 L${points.join(' L')} L1000,100 Z`
}

/** Tool errors arrive as JSON `{ status, message }`; show the message. */
export function aliveErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(text) as { message?: unknown }
    return typeof parsed.message === 'string' ? parsed.message : text
  } catch {
    return text
  }
}

export function aliveSettingsArgs(settings: AliveSettings): Record<string, unknown> {
  return {
    style: settings.style,
    motion: settings.motion,
    energy_sizing: settings.energySizing,
    snap_to_onsets: settings.snapToOnsets,
    avoid_faces: settings.avoidFaces,
    avoid_text: settings.avoidText,
    text_color: settings.textColor,
    hit_color: settings.hitColor,
  }
}

type AliveCommandAsset = {
  id: string
  artifactId: string
  type: string
  status: string
  mediaUrl: string | null
}

export function resolveAliveCommandAsset<Asset extends AliveCommandAsset>(
  reference: string | null,
  assets: readonly Asset[],
): { ok: true; asset: Asset & { mediaUrl: string } } | { ok: false; message: string } {
  const asset = reference
    ? assets.find((candidate) => candidate.artifactId === reference || candidate.id === reference)
    : undefined
  if (!reference || !asset) return { ok: false, message: 'Usage: /alive @video' }
  if (asset.type !== 'video') return { ok: false, message: '/alive requires a video asset' }
  if (asset.status !== 'ready' || !asset.mediaUrl) {
    return { ok: false, message: 'Process the video before opening alive captions' }
  }
  return { ok: true, asset: asset as Asset & { mediaUrl: string } }
}
