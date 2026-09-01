import {
  forwardRef,
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
}

export interface CanonicalSequencePlayerHandle {
  seekTo: (frame: number) => void
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

export const CanonicalSequencePlayer = forwardRef<
  CanonicalSequencePlayerHandle,
  CanonicalSequencePlayerProps
>(function CanonicalSequencePlayer({
  sequence,
  assets,
  onFrameUpdate,
  onKeyboardAction,
}, ref) {
  const playerRef = useRef<PlayerRef>(null)
  const [frame, setFrame] = useState(0)
  const fps = sequence.frameRate.numerator / sequence.frameRate.denominator
  const durationInFrames = sequenceDuration(sequence)
  const inputProps = useMemo(
    () => ({ sequence, assets }),
    [assets, sequence],
  )

  useImperativeHandle(ref, () => ({
    seekTo: (nextFrame) => {
      playerRef.current?.seekTo(Math.max(
        0,
        Math.min(durationInFrames - 1, Math.round(nextFrame)),
      ))
    },
  }), [durationInFrames])

  useEffect(() => {
    const player = playerRef.current
    if (!player) return
    const handler = (event: { detail: { frame: number } }) => {
      setFrame(event.detail.frame)
      onFrameUpdate(event.detail.frame)
    }
    player.addEventListener('frameupdate', handler)
    return () => player.removeEventListener('frameupdate', handler)
  }, [onFrameUpdate])

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const element = event.target as HTMLElement
    if (['INPUT', 'TEXTAREA', 'SELECT'].includes(element.tagName)) return
    const player = playerRef.current
    if (!player) return
    const key = event.key.toLowerCase()
    if (key === ' ' || key === 'k') {
      event.preventDefault()
      if (player.isPlaying()) player.pause()
      else player.play()
      return
    }
    if (key === 'j' || event.key === 'ArrowLeft') {
      event.preventDefault()
      player.seekTo(Math.max(0, frame - (key === 'j' ? Math.round(fps) : 1)))
      return
    }
    if (key === 'l' || event.key === 'ArrowRight') {
      event.preventDefault()
      player.seekTo(Math.min(
        durationInFrames - 1,
        frame + (key === 'l' ? Math.round(fps) : 1),
      ))
      return
    }
    const action = key === 'i'
      ? 'mark-in'
      : key === 'o'
        ? 'mark-out'
        : key === 's'
          ? 'split'
          : event.key === 'Delete' || event.key === 'Backspace'
            ? 'delete'
            : (event.metaKey || event.ctrlKey) && key === 'z'
              ? event.shiftKey ? 'redo' : 'undo'
              : key === 'f'
                ? 'search'
                : key === '+' || key === '='
                  ? 'zoom-in'
                  : key === '-'
                    ? 'zoom-out'
                    : null
    if (!action) return
    event.preventDefault()
    onKeyboardAction(action, frame)
  }

  return (
    <section
      className="canonical-player"
      tabIndex={0}
      onKeyDown={onKeyDown}
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
        <span>Space/K play · J/L shuttle · ←/→ frame · I/O marks · S split · Delete ripple · ⌘Z/⇧⌘Z restore</span>
      </footer>
    </section>
  )
})
