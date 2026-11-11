import { useMemo, useRef, type KeyboardEvent, type RefObject } from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'
import type { GraphicsEdit } from '../../../../server/src/graphics/edits'
import type { GraphicsLayerLayout } from '../../../../server/src/graphics/layout'
import type { GraphicsDocument, GraphicsTextSlot } from '../../../../server/src/graphics/model'
import { GraphicsPreviewComposition, type GraphicsPreviewProps } from '../../../../server/src/remotion/graphics/GraphicsPreviewComposition'
import { CAPTION_FONT_URLS } from '@/remotion/caption-font-urls'
import type { GraphicsOverlayImages } from '@/videobook/graphics-model'
import { formatCaptionTime } from '@/videobook/subtitles-model'
import { usePlayerFrame, useStageSize } from '../preview-stage'
import { GraphicsStageLayers } from './GraphicsStageLayers'

type GraphicsPreviewSource = { width: number; height: number; durationSeconds: number; fps: number }

type GraphicsPreviewStageProps = {
  document: GraphicsDocument
  mediaUrl: string
  source: GraphicsPreviewSource
  images: GraphicsOverlayImages
  layout: GraphicsLayerLayout[] | null
  playerRef: RefObject<PlayerRef | null>
  guides: boolean
  snapping: boolean
  editable: boolean
  selectedLayerId: string | null
  activeSlot: GraphicsTextSlot | null
  onLayout: (layout: GraphicsLayerLayout[]) => void
  onSelectLayer: (layerId: string) => void
  onEdit: (edits: GraphicsEdit[], coalesceKey: string) => boolean
}

const NO_FRAME_CHANGE = () => undefined

export function GraphicsPreview(props: GraphicsPreviewStageProps) {
  const { document, mediaUrl, source, images, layout, playerRef, guides } = props
  const durationInFrames = Math.max(1, Math.round(source.durationSeconds * source.fps))
  const { frame, playing, muted } = usePlayerFrame(playerRef, NO_FRAME_CHANGE)
  const time = frame / source.fps
  const containerRef = useRef<HTMLDivElement | null>(null)
  const aspect = useMemo(() => ({ width: source.width, height: source.height }), [source.height, source.width])
  const stage = useStageSize(containerRef, aspect, '.confirm-graphics')
  const { onLayout } = props

  const inputProps = useMemo<GraphicsPreviewProps>(() => ({
    videoSrc: mediaUrl,
    width: source.width,
    height: source.height,
    durationSeconds: source.durationSeconds,
    document,
    images,
    fontUrls: CAPTION_FONT_URLS,
    onLayout,
  }), [document, images, mediaUrl, onLayout, source.durationSeconds, source.height, source.width])

  const seekFrame = (target: number) => playerRef.current?.seekTo(Math.max(0, Math.min(durationInFrames - 1, Math.round(target))))

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key === ' ') {
      event.preventDefault()
      playerRef.current?.toggle()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const step = event.shiftKey ? source.fps : 1
      seekFrame(frame + (event.key === 'ArrowLeft' ? -step : step))
    }
  }

  return (
    <div className="graphics-preview" ref={containerRef} style={stage.stacked || stage.width === 0 ? undefined : { width: stage.width }}>
      <div
        className="graphics-stage"
        style={{ width: stage.width || undefined, height: stage.height || undefined, aspectRatio: `${source.width} / ${source.height}` }}
        tabIndex={0}
        role="group"
        aria-label="Graphics preview. Space plays or pauses; arrow keys step frames."
        onKeyDown={onKeyDown}
      >
        <Player
          ref={playerRef}
          component={GraphicsPreviewComposition}
          inputProps={inputProps}
          durationInFrames={durationInFrames}
          fps={source.fps}
          compositionWidth={source.width}
          compositionHeight={source.height}
          style={{ width: '100%', height: '100%' }}
          clickToPlay={false}
          spaceKeyToPlayOrPause={false}
          doubleClickToFullscreen={false}
        />
        <div className="graphics-overlay" data-frame={`${source.width}x${source.height}`}>
          {layout && (
            <GraphicsStageLayers
              document={document}
              layout={layout}
              source={source}
              seconds={time}
              selectedLayerId={props.selectedLayerId}
              activeSlot={props.activeSlot}
              editable={props.editable}
              snapping={props.snapping}
              guides={guides}
              onSelectLayer={props.onSelectLayer}
              onEdit={props.onEdit}
            />
          )}
        </div>
      </div>
      <div className="graphics-transport">
        <button type="button" className="graphics-icon-button" aria-label={playing ? 'Pause' : 'Play'} onClick={() => playerRef.current?.toggle()}>
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </button>
        <span className="graphics-time" aria-live="off">{formatCaptionTime(time)} / {formatCaptionTime(source.durationSeconds)}</span>
        <button
          type="button"
          className="graphics-icon-button"
          aria-label={muted ? 'Unmute preview' : 'Mute preview'}
          aria-pressed={muted}
          onClick={() => (muted ? playerRef.current?.unmute() : playerRef.current?.mute())}
        >
          {muted ? <VolumeX size={14} aria-hidden="true" /> : <Volume2 size={14} aria-hidden="true" />}
        </button>
      </div>
    </div>
  )
}
