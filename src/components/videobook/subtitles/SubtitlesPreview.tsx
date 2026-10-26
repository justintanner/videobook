import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import { Player, type PlayerRef } from '@remotion/player'
import { Pause, Play, Volume2, VolumeX } from 'lucide-react'
import { activeCaptionBlock, CAPTION_SAFE_ZONES, type CaptionRegionFrame } from '../../../../server/src/captions/layout'
import { CAPTION_ASPECT_SIZES, type CaptionDocument } from '../../../../server/src/captions/model'
import { CaptionComposition, type CaptionCompositionProps } from '../../../../server/src/remotion/captions/CaptionComposition'
import { useCaptionLayout } from '../../../../server/src/remotion/captions/caption-layout'
import { captionDurationInFrames } from '../../../../server/src/remotion/captions/composition-meta'
import { CAPTION_FONT_URLS } from '@/remotion/caption-font-urls'
import { formatCaptionTime } from '@/videobook/subtitles-model'

export type SubtitlePositionTarget = 'all' | 'phrase'

type SubtitlesPreviewProps = {
  document: CaptionDocument
  mediaUrl: string
  source: { width: number; height: number; durationSeconds: number }
  regions: CaptionRegionFrame[]
  playerRef: RefObject<PlayerRef | null>
  guides: boolean
  selectedPhraseId: string | null
  onFrameChange: (frame: number) => void
  onDragPosition: (centerY: number, phraseId: string) => void
  onSelectPhrase: (phraseId: string) => void
}

type Drag = { pointerId: number; startY: number; startCenter: number; height: number; phraseId: string }

function useFrame(playerRef: RefObject<PlayerRef | null>, onFrameChange: (frame: number) => void) {
  const [frame, setFrame] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(false)
  const callback = useRef(onFrameChange)
  useLayoutEffect(() => {
    callback.current = onFrameChange
  }, [onFrameChange])
  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    const onFrame = (event: { detail: { frame: number } }) => {
      setFrame(event.detail.frame)
      callback.current(event.detail.frame)
    }
    const onPlay = () => setPlaying(true)
    const onPause = () => setPlaying(false)
    const onMute = (event: { detail: { isMuted: boolean } }) => setMuted(event.detail.isMuted)
    player.addEventListener('frameupdate', onFrame)
    player.addEventListener('seeked', onFrame)
    player.addEventListener('play', onPlay)
    player.addEventListener('pause', onPause)
    player.addEventListener('mutechange', onMute)
    return () => {
      player.removeEventListener('frameupdate', onFrame)
      player.removeEventListener('seeked', onFrame)
      player.removeEventListener('play', onPlay)
      player.removeEventListener('pause', onPause)
      player.removeEventListener('mutechange', onMute)
    }
  }, [playerRef])
  return { frame, playing, muted }
}

const TRANSPORT_HEIGHT = 34
const DESKTOP_PREVIEW_FRACTION = 0.42
const STACKED_BREAKPOINT = 900

function useStageSize(containerRef: RefObject<HTMLDivElement | null>, aspect: { width: number; height: number }) {
  const [box, setBox] = useState({ width: 0, height: 0, stacked: false })
  useEffect(() => {
    const element = containerRef.current
    const grid = element?.closest<HTMLElement>('.confirm-subtitles')
    if (!element || !grid) return
    const measure = () => {
      const stacked = grid.clientWidth < STACKED_BREAKPOINT
      const availableHeight = Math.max(80, element.clientHeight - TRANSPORT_HEIGHT)
      const availableWidth = stacked ? element.clientWidth : grid.clientWidth * DESKTOP_PREVIEW_FRACTION
      const scale = Math.min(availableWidth / aspect.width, availableHeight / aspect.height)
      const next = { width: Math.floor(aspect.width * scale), height: Math.floor(aspect.height * scale), stacked }
      setBox((current) => (current.width === next.width && current.height === next.height && current.stacked === next.stacked ? current : next))
    }
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    observer.observe(grid)
    return () => observer.disconnect()
  }, [aspect.height, aspect.width, containerRef])
  return box
}

function percent(value: number): string {
  return `${(value * 100).toFixed(3)}%`
}

export function SubtitlesPreview(props: SubtitlesPreviewProps) {
  const { document, mediaUrl, source, regions, playerRef, guides, selectedPhraseId } = props
  const size = CAPTION_ASPECT_SIZES[document.aspect]
  const fps = document.source.fps
  const durationInFrames = captionDurationInFrames(source.durationSeconds, fps)
  const { frame, playing, muted } = useFrame(playerRef, props.onFrameChange)
  const time = frame / fps
  const layout = useCaptionLayout(document, regions, CAPTION_FONT_URLS)
  const block = activeCaptionBlock(layout.blocks, time)
  const overlayRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<Drag | null>(null)
  const zone = CAPTION_SAFE_ZONES[document.aspect]
  const containerRef = useRef<HTMLDivElement | null>(null)
  const stage = useStageSize(containerRef, size)

  const inputProps = useMemo<CaptionCompositionProps>(() => ({
    videoSrc: mediaUrl,
    sourceWidth: source.width,
    sourceHeight: source.height,
    durationInFrames,
    fps,
    document,
    regions,
    fontUrls: CAPTION_FONT_URLS,
  }), [document, durationInFrames, fps, mediaUrl, regions, source.height, source.width])

  const seekFrame = (target: number) => playerRef.current?.seekTo(Math.max(0, Math.min(durationInFrames - 1, Math.round(target))))

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const overlay = overlayRef.current
    if (!block || !overlay || event.button !== 0) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    props.onSelectPhrase(block.cue.phraseId)
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY, startCenter: block.centerY, height: overlay.getBoundingClientRect().height, phraseId: block.cue.phraseId }
  }

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current
    if (!drag || drag.pointerId !== event.pointerId) return
    const centerY = Math.max(0, Math.min(1, drag.startCenter + (event.clientY - drag.startY) / drag.height))
    props.onDragPosition(Math.round(centerY * 1000) / 1000, drag.phraseId)
  }

  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return
    dragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId)
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key === ' ') {
      event.preventDefault()
      playerRef.current?.toggle()
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault()
      const step = event.shiftKey ? fps : 1
      seekFrame(frame + (event.key === 'ArrowLeft' ? -step : step))
    }
  }

  const blockStyle: CSSProperties | undefined = block ? {
    left: percent(block.x / size.width),
    top: percent(block.y / size.height),
    width: percent(block.width / size.width),
    height: percent(block.height / size.height),
  } : undefined

  return (
    <div className="subtitles-preview" ref={containerRef} style={stage.stacked || stage.width === 0 ? undefined : { width: stage.width }}>
      <div
        className="subtitles-stage"
        style={{ width: stage.width || undefined, height: stage.height || undefined }}
        tabIndex={0}
        role="group"
        aria-label="Subtitle preview. Space plays or pauses; arrow keys step frames."
        onKeyDown={onKeyDown}
      >
        <Player
          ref={playerRef}
          component={CaptionComposition}
          inputProps={inputProps}
          durationInFrames={durationInFrames}
          fps={fps}
          compositionWidth={size.width}
          compositionHeight={size.height}
          style={{ width: '100%', height: '100%' }}
          clickToPlay={false}
          spaceKeyToPlayOrPause={false}
          doubleClickToFullscreen={false}
        />
        <div className="subtitles-overlay" ref={overlayRef}>
          {guides && (
            <>
              <div className="subtitles-guide subtitles-guide-top" style={{ height: percent(zone.top) }}><span>Top bar</span></div>
              <div className="subtitles-guide subtitles-guide-bottom" style={{ height: percent(zone.bottom) }}><span>Caption &amp; buttons</span></div>
              <div className="subtitles-guide subtitles-guide-right" style={{ width: percent(zone.right), top: percent(zone.top), bottom: percent(zone.bottom) }} />
            </>
          )}
          {block && (
            <div
              className="subtitles-drag-block"
              data-selected={block.cue.phraseId === selectedPhraseId ? 'true' : undefined}
              data-placement={block.placement}
              style={blockStyle}
              title="Drag to move the subtitles up or down"
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={endDrag}
              onPointerCancel={endDrag}
            />
          )}
        </div>
      </div>
      <div className="subtitles-transport">
        <button type="button" className="subtitles-icon-button" aria-label={playing ? 'Pause' : 'Play'} onClick={() => playerRef.current?.toggle()}>
          {playing ? <Pause size={14} aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        </button>
        <input
          type="range"
          className="subtitles-seek"
          aria-label="Playback position"
          min={0}
          max={Math.max(0, durationInFrames - 1)}
          step={1}
          value={Math.min(frame, durationInFrames - 1)}
          onChange={(event) => seekFrame(Number(event.target.value))}
        />
        <span className="subtitles-time" aria-live="off">{formatCaptionTime(time)} / {formatCaptionTime(source.durationSeconds)}</span>
        <button
          type="button"
          className="subtitles-icon-button"
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
