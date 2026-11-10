import { useMemo, useRef, type CSSProperties, type KeyboardEvent, type RefObject } from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { graphicsSpaceRect, type GraphicsLayerLayout, type GraphicsRect } from '../../../../server/src/graphics/layout'
import type { GraphicsDocument, GraphicsLayer } from '../../../../server/src/graphics/model'
import { layerOpacityAt, resolveLayerTiming } from '../../../../server/src/graphics/timing'
import { GraphicsPreviewComposition, type GraphicsPreviewProps } from '../../../../server/src/remotion/graphics/GraphicsPreviewComposition'
import { CAPTION_FONT_URLS } from '@/remotion/caption-font-urls'
import type { GraphicsOverlayImages } from '@/videobook/graphics-model'
import { formatCaptionTime } from '@/videobook/subtitles-model'
import { usePlayerFrame, useStageSize } from '../preview-stage'

type GraphicsPreviewSource = { width: number; height: number; durationSeconds: number; fps: number }

type GraphicsPreviewStageProps = {
  document: GraphicsDocument
  mediaUrl: string
  source: GraphicsPreviewSource
  images: GraphicsOverlayImages
  layout: GraphicsLayerLayout[] | null
  playerRef: RefObject<PlayerRef | null>
  guides: boolean
  selectedLayerId: string | null
  onLayout: (layout: GraphicsLayerLayout[]) => void
  onSelectLayer: (layerId: string) => void
}

const NO_FRAME_CHANGE = () => undefined

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`
}

function boxStyle(box: GraphicsRect, source: GraphicsPreviewSource): CSSProperties {
  return {
    left: percent(box.x / source.width),
    top: percent(box.y / source.height),
    width: percent(box.width / source.width),
    height: percent(box.height / source.height),
  }
}

function boxData(box: GraphicsRect): string {
  return [box.x, box.y, box.width, box.height].map((value) => Math.round(value)).join(',')
}

function shownAt(layer: GraphicsLayer, seconds: number, durationSeconds: number): boolean {
  return layerOpacityAt(resolveLayerTiming(layer.timing, durationSeconds), seconds) > 0
}

function LayerBoxes({ document, layout, source, seconds, selectedLayerId, onSelectLayer }: {
  document: GraphicsDocument
  layout: GraphicsLayerLayout[]
  source: GraphicsPreviewSource
  seconds: number
  selectedLayerId: string | null
  onSelectLayer: (layerId: string) => void
}) {
  const layers = new Map(document.layers.map((layer) => [layer.id, layer]))
  return layout.flatMap((entry) => {
    const layer = layers.get(entry.layerId)
    if (!layer || entry.kind === 'scrim') return []
    const selected = entry.layerId === selectedLayerId
    if (!selected && !shownAt(layer, seconds, source.durationSeconds)) return []
    return [(
      <button
        key={entry.layerId}
        type="button"
        className="graphics-layer-box"
        data-layer-id={entry.layerId}
        data-box={boxData(entry.box)}
        data-selected={selected ? 'true' : undefined}
        aria-label={`Select ${layer.name}`}
        aria-pressed={selected}
        style={boxStyle(entry.box, source)}
        onClick={() => onSelectLayer(entry.layerId)}
      >
        {entry.kind === 'text' && entry.items.map((item) => {
          const slot = layer.kind === 'text' ? layer.items.find((candidate) => candidate.id === item.itemId)?.slot ?? undefined : undefined
          const relative = { x: item.box.x - entry.box.x, y: item.box.y - entry.box.y, width: item.box.width, height: item.box.height }
          return (
            <span
              key={item.itemId}
              className="graphics-item-box"
              data-item-id={item.itemId}
              data-slot={slot}
              data-box={boxData(item.box)}
              data-overflow={item.overflow ? 'true' : undefined}
              style={boxStyle(relative, { ...source, width: entry.box.width, height: entry.box.height })}
            />
          )
        })}
      </button>
    )]
  })
}

export function GraphicsPreview(props: GraphicsPreviewStageProps) {
  const { document, mediaUrl, source, images, layout, playerRef, guides } = props
  const durationInFrames = Math.max(1, Math.round(source.durationSeconds * source.fps))
  const { frame, playing, muted } = usePlayerFrame(playerRef, NO_FRAME_CHANGE)
  const time = frame / source.fps
  const containerRef = useRef<HTMLDivElement | null>(null)
  const aspect = useMemo(() => ({ width: source.width, height: source.height }), [source.height, source.width])
  const stage = useStageSize(containerRef, aspect, '.confirm-graphics')
  const safe = useMemo(() => graphicsSpaceRect(aspect, 'safe'), [aspect])
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
          {guides && <div className="graphics-guide-safe" style={boxStyle(safe, source)} />}
          {layout && (
            <LayerBoxes
              document={document}
              layout={layout}
              source={source}
              seconds={time}
              selectedLayerId={props.selectedLayerId}
              onSelectLayer={props.onSelectLayer}
            />
          )}
        </div>
      </div>
      <div className="graphics-transport">
        <button type="button" className="graphics-icon-button" aria-label={playing ? 'Pause' : 'Play'} onClick={() => playerRef.current?.toggle()}>
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </button>
        <input
          type="range"
          className="graphics-seek"
          aria-label="Playback position"
          min={0}
          max={Math.max(0, durationInFrames - 1)}
          step={1}
          value={Math.min(frame, durationInFrames - 1)}
          onChange={(event) => seekFrame(Number(event.target.value))}
        />
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
