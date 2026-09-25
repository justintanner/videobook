import { AbsoluteFill, Video, useCurrentFrame, useVideoConfig } from 'remotion'
import { AliveCaptions } from '../../server/src/remotion/subtitles/AliveCaptions'
import { activeCue, avoidedRegions, contentRect, regionToTarget } from '../../server/src/remotion/subtitles/alive-layout'
import type {
  AliveColumn,
  AliveCue,
  AlivePhrase,
  AliveRegion,
  AliveSettings,
} from '../../server/src/remotion/subtitles/alive-types'

export interface AliveCaptionsPreviewProps extends Record<string, unknown> {
  mediaUrl: string
  sourceWidth: number
  sourceHeight: number
  cues: AliveCue[]
  phrases: AlivePhrase[]
  settings: AliveSettings
  showRegions: boolean
}

const REGION_COLORS: Record<AliveRegion['kind'], string> = {
  face: '#63c7d8',
  text: '#f0a860',
  graphic: '#f0a860',
}

function RegionOverlay({ phrase, cue, settings, sourceWidth, sourceHeight }: {
  phrase: AlivePhrase
  cue: AliveCue
  settings: AliveSettings
  sourceWidth: number
  sourceHeight: number
}) {
  const { width, height } = useVideoConfig()
  const geometry = { sourceWidth, sourceHeight, targetWidth: width, targetHeight: height }
  const avoided = new Set(avoidedRegions(phrase.regions, settings))
  const stroke = Math.max(2, Math.round(width / 480))
  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      {phrase.regions.map((region, index) => {
        const box = regionToTarget(region, geometry)
        return (
          <div
            key={`${phrase.id}-${index}`}
            style={{
              position: 'absolute',
              left: box.x * width,
              top: box.y * height,
              width: box.width * width,
              height: box.height * height,
              border: `${stroke}px dashed ${REGION_COLORS[region.kind]}`,
              opacity: avoided.has(region) ? 1 : 0.4,
              borderRadius: stroke * 2,
            }}
          />
        )
      })}
      <ColumnOutline column={cue.column} stroke={stroke} />
    </AbsoluteFill>
  )
}

function ColumnOutline({ column, stroke }: { column: AliveColumn; stroke: number }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: column.x,
        top: column.y,
        width: column.width,
        height: column.height,
        border: `${Math.max(1, stroke / 2)}px dashed rgba(114, 231, 170, 0.6)`,
        borderRadius: stroke * 2,
      }}
    />
  )
}

export function AliveCaptionsPreview({
  mediaUrl,
  sourceWidth,
  sourceHeight,
  cues,
  phrases,
  settings,
  showRegions,
}: AliveCaptionsPreviewProps) {
  const frame = useCurrentFrame()
  const { fps, width, height } = useVideoConfig()
  const content = contentRect({ sourceWidth, sourceHeight, targetWidth: width, targetHeight: height })
  const cue = activeCue(cues, frame / fps)
  const phrase = cue ? phrases.find((candidate) => candidate.id === cue.id) : undefined
  return (
    <AbsoluteFill style={{ background: '#000000' }}>
      <Video
        src={mediaUrl}
        style={{ position: 'absolute', left: content.x, top: content.y, width: content.width, height: content.height }}
      />
      {showRegions && cue && phrase && (
        <RegionOverlay phrase={phrase} cue={cue} settings={settings} sourceWidth={sourceWidth} sourceHeight={sourceHeight} />
      )}
      <AliveCaptions cues={cues} settings={settings} strokeWidth={6} strokeColor="#000000" shadowBlur={6} shadowOpacity={60} />
    </AbsoluteFill>
  )
}
