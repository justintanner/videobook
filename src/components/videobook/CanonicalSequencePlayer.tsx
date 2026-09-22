import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react'
import {
  Player,
  type PlayerRef,
  type RenderPlayPauseButton,
} from '@remotion/player'
import { LoaderCircle, Pause, Play } from 'lucide-react'
import type { Sequence } from 'videobook-engine'
import {
  CanonicalSequenceComposition,
  type CanonicalPlaybackAsset,
} from '@/remotion/CanonicalSequenceComposition'

export type TimelineKeyboardAction =
  | 'mark-in'
  | 'mark-out'
  | 'split'
  | 'delete'
  | 'undo'
  | 'redo'
  | 'search'
  | 'zoom-in'
  | 'zoom-out'

interface CanonicalSequencePlayerProps {
  sequence: Sequence
  assets: CanonicalPlaybackAsset[]
  onFrameUpdate: (frame: number) => void
  onKeyboardAction: (action: TimelineKeyboardAction, frame: number) => void
  editingEnabled?: boolean
  presentation?: 'default' | 'preview'
  allowFullscreen?: boolean
  initialFrame?: number
}

export interface CanonicalSequencePlayerHandle {
  seekTo: (frame: number) => void
  focus: () => void
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

const defaultPlayerStyle: CSSProperties = { width: '100%', maxHeight: 520 }
const previewPlayerStyle: CSSProperties = { width: '100%', height: '100%' }

const renderPreviewPlayButton: RenderPlayPauseButton = ({ playing, isBuffering }) => (
  isBuffering
    ? <LoaderCircle size={16} className="timeline-preview-buffering" />
    : playing ? <Pause size={16} /> : <Play size={16} />
)

function sequenceDuration(sequence: Sequence): number {
  return Math.max(
    1,
    ...sequence.clips.map((clip) =>
      clip.timelineStartFrame + clip.durationFrames),
    ...sequence.captions.map((cue) =>
      cue.timelineStartFrame + cue.durationFrames),
  )
}

function keyboardAction(
  event: KeyboardEvent<HTMLElement>,
): TimelineKeyboardAction | null {
  const key = event.key.toLowerCase()
  if (key === 'i') return 'mark-in'
  if (key === 'o') return 'mark-out'
  if (key === 's') return 'split'
  if (event.key === 'Delete' || event.key === 'Backspace') return 'delete'
  if ((event.metaKey || event.ctrlKey) && key === 'z') {
    return event.shiftKey ? 'redo' : 'undo'
  }
  if (key === 'f') return 'search'
  if (key === '+' || key === '=') return 'zoom-in'
  if (key === '-') return 'zoom-out'
  return null
}

export const CanonicalSequencePlayer = forwardRef<
  CanonicalSequencePlayerHandle,
  CanonicalSequencePlayerProps
>(function CanonicalSequencePlayer({
  sequence,
  assets,
  onFrameUpdate,
  onKeyboardAction,
  editingEnabled = true,
  presentation = 'default',
  allowFullscreen = true,
  initialFrame = 0,
}, ref) {
  const playerRef = useRef<PlayerRef>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const fps = sequence.frameRate.numerator / sequence.frameRate.denominator
  const durationInFrames = sequenceDuration(sequence)
  const firstFrame = Math.max(0, Math.min(durationInFrames - 1, Math.round(initialFrame)))
  const frameRef = useRef(firstFrame)
  const [frame, setFrame] = useState(firstFrame)
  const isPreview = presentation === 'preview'
  const inputProps = useMemo(
    () => ({ sequence, assets }),
    [assets, sequence],
  )

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLElement>) => {
    const element = event.target as HTMLElement
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return
    const player = playerRef.current
    if (!player) return
    const current = frameRef.current
    const key = event.key.toLowerCase()
    if (key === ' ' || key === 'k') {
      event.preventDefault()
      if (player.isPlaying()) player.pause()
      else player.play()
      return
    }
    if (key === 'j' || event.key === 'ArrowLeft') {
      event.preventDefault()
      player.seekTo(Math.max(0, current - (key === 'j' ? Math.round(fps) : 1)))
      return
    }
    if (key === 'l' || event.key === 'ArrowRight') {
      event.preventDefault()
      player.seekTo(Math.min(
        durationInFrames - 1,
        current + (key === 'l' ? Math.round(fps) : 1),
      ))
      return
    }
    if (!editingEnabled) return
    const action = keyboardAction(event)
    if (!action) return
    event.preventDefault()
    onKeyboardAction(action, current)
  }, [durationInFrames, editingEnabled, fps, onKeyboardAction])

  useImperativeHandle(ref, () => ({
    seekTo: (nextFrame) => {
      playerRef.current?.seekTo(Math.max(
        0,
        Math.min(durationInFrames - 1, Math.round(nextFrame)),
      ))
    },
    focus: () => sectionRef.current?.focus(),
    handleKeyDown,
  }), [durationInFrames, handleKeyDown])

  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    const handler = (event: { detail: { frame: number } }) => {
      frameRef.current = event.detail.frame
      setFrame(event.detail.frame)
      onFrameUpdate(event.detail.frame)
    }
    player.addEventListener('frameupdate', handler)
    return () => player.removeEventListener('frameupdate', handler)
  }, [onFrameUpdate])

  const player = (
    <Player
      ref={playerRef}
      component={CanonicalSequenceComposition}
      inputProps={inputProps}
      durationInFrames={durationInFrames}
      fps={fps}
      compositionWidth={sequence.width}
      compositionHeight={sequence.height}
      initialFrame={firstFrame}
      controls
      spaceKeyToPlayOrPause={isPreview ? false : undefined}
      allowFullscreen={allowFullscreen}
      alwaysShowControls={isPreview}
      className={isPreview ? 'timeline-preview-screen' : undefined}
      style={isPreview ? previewPlayerStyle : defaultPlayerStyle}
      renderPlayPauseButton={isPreview ? renderPreviewPlayButton : undefined}
    />
  )

  return (
    <section
      className={isPreview ? 'canonical-player canonical-player-preview' : 'canonical-player'}
      ref={sectionRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Canonical sequence player"
    >
      {isPreview ? <div className="timeline-preview-stage">{player}</div> : player}
      <footer>
        <span className="canonical-player-frame" title="Current frame">F{frame}</span>
        <span>{(frame / fps).toFixed(2)}s</span>
        <span className="canonical-player-shortcuts">{editingEnabled ? 'Space/K play · J/L shuttle · ←/→ frame · I/O marks · S split · Delete ripple · ⌘Z/⇧⌘Z restore' : 'Space/K play · J/L shuttle · ←/→ frame'}</span>
      </footer>
    </section>
  )
})
