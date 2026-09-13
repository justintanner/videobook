import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { Player, type PlayerRef } from '@remotion/player'
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
}

export interface CanonicalSequencePlayerHandle {
  seekTo: (frame: number) => void
  focus: () => void
  handleKeyDown: (event: KeyboardEvent<HTMLElement>) => void
}

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
}, ref) {
  const playerRef = useRef<PlayerRef>(null)
  const sectionRef = useRef<HTMLElement>(null)
  const frameRef = useRef(0)
  const [frame, setFrame] = useState(0)
  const fps = sequence.frameRate.numerator / sequence.frameRate.denominator
  const durationInFrames = sequenceDuration(sequence)
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

  return (
    <section
      className="canonical-player"
      ref={sectionRef}
      tabIndex={0}
      onKeyDown={handleKeyDown}
      aria-label="Canonical sequence player"
    >
      <Player
        ref={playerRef}
        component={CanonicalSequenceComposition}
        inputProps={inputProps}
        durationInFrames={durationInFrames}
        fps={fps}
        compositionWidth={sequence.width}
        compositionHeight={sequence.height}
        controls
        style={{ width: '100%', maxHeight: 520 }}
      />
      <footer>
        <span>F{frame}</span>
        <span>{(frame / fps).toFixed(2)}s</span>
        <span>{editingEnabled ? 'Space/K play · J/L shuttle · ←/→ frame · I/O marks · S split · Delete ripple · ⌘Z/⇧⌘Z restore' : 'Space/K play · J/L shuttle · ←/→ frame'}</span>
      </footer>
    </section>
  )
})
