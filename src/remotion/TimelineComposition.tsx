import React, { useCallback } from 'react';
import { Audio, Sequence, Series, Video, useVideoConfig } from 'remotion';

export interface TimelineSlotData {
  src: string;
  durationInFrames: number;
  volume: number;        // 0-100
  fadeIn: number;        // ms
  fadeOut: number;       // ms
}

export interface TimelineAudioOverlayData {
  id: string;
  src: string;
  startFrame: number;
  durationFrames: number;
  volume: number;        // 0-100
  fadeIn: number;        // ms
  fadeOut: number;       // ms
}

interface TimelineCompositionProps {
  slots: TimelineSlotData[];
  audioClips?: TimelineAudioOverlayData[];
}

function SlotVideo({ slot }: { slot: TimelineSlotData }) {
  const { fps } = useVideoConfig();
  const { volume, fadeIn, fadeOut, durationInFrames } = slot;

  const fadeInFrames = Math.round((fadeIn / 1000) * fps);
  const fadeOutFrames = Math.round((fadeOut / 1000) * fps);

  const volumeCallback = useCallback(
    (frame: number) => {
      const baseVolume = volume / 100;
      if (frame < fadeInFrames) {
        return baseVolume * (frame / fadeInFrames);
      }
      const framesFromEnd = durationInFrames - frame;
      if (framesFromEnd < fadeOutFrames) {
        return baseVolume * (framesFromEnd / fadeOutFrames);
      }
      return baseVolume;
    },
    [volume, fadeInFrames, fadeOutFrames, durationInFrames],
  );

  return (
    <Video
      src={slot.src}
      style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      volume={volumeCallback}
    />
  );
}

function OverlayAudio({ overlay }: { overlay: TimelineAudioOverlayData }) {
  const { fps } = useVideoConfig();
  const { volume, fadeIn, fadeOut, durationFrames } = overlay;

  const fadeInFrames = Math.round((fadeIn / 1000) * fps);
  const fadeOutFrames = Math.round((fadeOut / 1000) * fps);

  const volumeCallback = useCallback(
    (frame: number) => {
      const baseVolume = volume / 100;
      if (fadeInFrames > 0 && frame < fadeInFrames) {
        return baseVolume * (frame / fadeInFrames);
      }
      const framesFromEnd = durationFrames - frame;
      if (fadeOutFrames > 0 && framesFromEnd < fadeOutFrames) {
        return baseVolume * Math.max(0, framesFromEnd / fadeOutFrames);
      }
      return baseVolume;
    },
    [volume, fadeInFrames, fadeOutFrames, durationFrames],
  );

  return <Audio src={overlay.src} volume={volumeCallback} />;
}

export const TimelineComposition: React.FC<TimelineCompositionProps> = ({ slots, audioClips }) => {
  return (
    <>
      <Series>
        {slots.map((slot, i) => (
          <Series.Sequence key={i} durationInFrames={slot.durationInFrames}>
            <SlotVideo slot={slot} />
          </Series.Sequence>
        ))}
      </Series>
      {(audioClips ?? []).map((overlay) => (
        <Sequence
          key={overlay.id}
          from={overlay.startFrame}
          durationInFrames={overlay.durationFrames}
        >
          <OverlayAudio overlay={overlay} />
        </Sequence>
      ))}
    </>
  );
};
