import { useCallback } from 'react'
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence as RemotionSequence,
  Video,
  interpolate,
  useCurrentFrame,
} from 'remotion'
import type {
  Sequence,
  SequenceClip,
  SequenceTransition,
  TimedSequenceClip,
} from 'videobook-engine'

export interface CanonicalPlaybackAsset {
  artifactId: string
  mediaUrl: string
}

interface CanonicalSequenceCompositionProps {
  sequence: Sequence
  assets: CanonicalPlaybackAsset[]
}

function frameRate(sequence: Sequence): number {
  return sequence.frameRate.numerator / sequence.frameRate.denominator
}

function sourceStartFrame(sequence: Sequence, clip: TimedSequenceClip): number {
  const seconds = clip.source.range.startTick
    * clip.source.range.timeBase.numerator
    / clip.source.range.timeBase.denominator
  return Math.max(0, Math.round(seconds * frameRate(sequence)))
}

function sourceEndFrame(sequence: Sequence, clip: TimedSequenceClip): number {
  const seconds = (
    clip.source.range.startTick + clip.source.range.durationTicks
  ) * clip.source.range.timeBase.numerator
    / clip.source.range.timeBase.denominator
  return Math.max(sourceStartFrame(sequence, clip) + 1, Math.ceil(seconds * frameRate(sequence)))
}

function clipTransitions(
  clip: SequenceClip,
  transitions: SequenceTransition[],
) {
  return {
    incoming: transitions.find((transition) =>
      transition.kind === 'dissolve' && transition.incomingClipId === clip.clipId),
    outgoing: transitions.find((transition) =>
      transition.kind === 'dissolve' && transition.outgoingClipId === clip.clipId),
  }
}

function VisualClip({
  sequence,
  clip,
  src,
}: {
  sequence: Sequence
  clip: SequenceClip
  src: string
}) {
  const frame = useCurrentFrame()
  const transform = clip.transform
  const transitions = clipTransitions(clip, sequence.transitions)
  const incomingOpacity = transitions.incoming
    ? interpolate(
        frame,
        [0, transitions.incoming.durationFrames],
        [0, 1],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      )
    : 1
  const outgoingOpacity = transitions.outgoing
    ? interpolate(
        frame,
        [
          Math.max(0, clip.durationFrames - transitions.outgoing.durationFrames),
          clip.durationFrames,
        ],
        [1, 0],
        { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' },
      )
    : 1
  const style = {
    width: '100%',
    height: '100%',
    objectFit: transform?.fit === 'fit' ? 'contain' : 'cover',
    objectPosition: 'center',
    opacity: (transform?.opacity ?? 1) * incomingOpacity * outgoingOpacity,
    transform: [
      `translate(${transform?.positionX ?? 0}px, ${transform?.positionY ?? 0}px)`,
      `scale(${transform?.scaleX ?? 1}, ${transform?.scaleY ?? 1})`,
      `rotate(${transform?.rotationDegrees ?? 0}deg)`,
    ].join(' '),
    transformOrigin: `${(transform?.anchorX ?? 0.5) * 100}% ${(transform?.anchorY ?? 0.5) * 100}%`,
    clipPath: transform
      ? `inset(${transform.cropTop * 100}% ${transform.cropRight * 100}% ${transform.cropBottom * 100}% ${transform.cropLeft * 100}%)`
      : undefined,
  } as const
  if (clip.source.kind === 'still') return <Img src={src} style={style} />
  const timed = clip as TimedSequenceClip
  if (timed.reverse) {
    return (
      <AbsoluteFill style={{ ...style, display: 'grid', placeItems: 'center', background: '#07120c' }}>
        <span style={{ color: '#8fbaa0', fontFamily: 'monospace', fontSize: 24 }}>
          Reverse preview is available after render
        </span>
      </AbsoluteFill>
    )
  }
  return (
    <Video
      src={src}
      startFrom={sourceStartFrame(sequence, timed)}
      endAt={sourceEndFrame(sequence, timed)}
      playbackRate={timed.speed.numerator / timed.speed.denominator}
      muted={timed.audioPolicy === 'mute'}
      style={style}
    />
  )
}

function AudioClip({
  sequence,
  clip,
  src,
}: {
  sequence: Sequence
  clip: TimedSequenceClip
  src: string
}) {
  const audio = clip.audio
  const transitions = clipTransitions(clip, sequence.transitions)
  const volume = useCallback((frame: number) => {
    if (audio?.muted) return 0
    const base = 10 ** ((audio?.gainDb ?? 0) / 20)
    const fadeIn = Math.max(
      1,
      audio?.fadeInFrames ?? 0,
      transitions.incoming?.durationFrames ?? 0,
    )
    const fadeOut = Math.max(
      1,
      audio?.fadeOutFrames ?? 0,
      transitions.outgoing?.durationFrames ?? 0,
    )
    if (fadeIn > 0 && frame < fadeIn) return base * frame / fadeIn
    if (fadeOut > 0 && frame > clip.durationFrames - fadeOut) {
      return base * Math.max(0, clip.durationFrames - frame) / fadeOut
    }
    return base
  }, [audio, clip.durationFrames, transitions.incoming, transitions.outgoing])
  if (clip.reverse) return null
  return (
    <Audio
      src={src}
      startFrom={sourceStartFrame(sequence, clip)}
      endAt={sourceEndFrame(sequence, clip)}
      playbackRate={clip.speed.numerator / clip.speed.denominator}
      volume={volume}
      muted={clip.audioPolicy === 'mute' || audio?.muted}
    />
  )
}

function Caption({
  text,
  styleId,
}: {
  text: string
  styleId: string
}) {
  const styles = styleId === 'bold'
    ? { background: '#ffe500', color: '#090909', fontWeight: 900 }
    : styleId === 'high-contrast'
      ? { background: '#000', color: '#fff', fontWeight: 800 }
      : { background: 'rgba(0, 0, 0, 0.78)', color: '#fff', fontWeight: 700 }
  return (
    <AbsoluteFill style={{ justifyContent: 'flex-end', alignItems: 'center', padding: '0 6% 7%' }}>
      <span style={{
        ...styles,
        maxWidth: '88%',
        padding: '0.3em 0.55em',
        fontFamily: 'Inter, system-ui, sans-serif',
        fontSize: 52,
        lineHeight: 1.15,
        textAlign: 'center',
      }}>
        {text}
      </span>
    </AbsoluteFill>
  )
}

export function CanonicalSequenceComposition({
  sequence,
  assets,
}: CanonicalSequenceCompositionProps) {
  const assetById = new Map(assets.map((asset) => [asset.artifactId, asset]))
  const trackById = new Map(sequence.tracks.map((track) => [track.trackId, track]))
  const soloAudio = sequence.tracks.some((track) =>
    track.kind === 'audio' && track.solo)
  const visualClips = sequence.clips
    .filter((clip) => {
      const track = trackById.get(clip.trackId)
      return clip.enabled && track?.enabled && track.kind === 'video'
    })
    .sort((left, right) => {
      const leftTrack = trackById.get(left.trackId)
      const rightTrack = trackById.get(right.trackId)
      return (leftTrack?.ordinal ?? 0) - (rightTrack?.ordinal ?? 0)
    })
  const audioClips = sequence.clips.flatMap((clip) => {
    const track = trackById.get(clip.trackId)
    if (
      !clip.enabled
      || clip.source.kind !== 'timed'
      || !track?.enabled
      || track.kind !== 'audio'
      || track.muted
      || (soloAudio && !track.solo)
    ) return []
    return [clip as TimedSequenceClip]
  })
  return (
    <AbsoluteFill style={{
      backgroundColor: `rgba(${sequence.backgroundRgba.join(',')})`,
    }}>
      {visualClips.map((clip) => {
        const asset = assetById.get(clip.source.artifactId)
        return asset && (
          <RemotionSequence
            from={clip.timelineStartFrame}
            durationInFrames={clip.durationFrames}
            key={clip.clipId}
          >
            <VisualClip sequence={sequence} clip={clip} src={asset.mediaUrl} />
          </RemotionSequence>
        )
      })}
      {audioClips.map((clip) => {
        const asset = assetById.get(clip.source.artifactId)
        return asset && (
          <RemotionSequence
            from={clip.timelineStartFrame}
            durationInFrames={clip.durationFrames}
            key={`audio:${clip.clipId}`}
          >
            <AudioClip sequence={sequence} clip={clip} src={asset.mediaUrl} />
          </RemotionSequence>
        )
      })}
      {sequence.captions.map((cue) => (
        <RemotionSequence
          from={cue.timelineStartFrame}
          durationInFrames={cue.durationFrames}
          key={cue.cueId}
        >
          <Caption text={cue.text} styleId={cue.styleId} />
        </RemotionSequence>
      ))}
    </AbsoluteFill>
  )
}
