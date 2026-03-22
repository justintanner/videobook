import React, { useCallback } from 'react';
import { Series, Video, useVideoConfig } from 'remotion';

export interface TimelineSlotData {
  src: string;
  durationInFrames: number;
  volume: number;        // 0-100
  fadeIn: number;        // ms
  fadeOut: number;       // ms
}

interface TimelineCompositionProps {
  slots: TimelineSlotData[];
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

export const TimelineComposition: React.FC<TimelineCompositionProps> = ({ slots }) => {
  return (
    <Series>
      {slots.map((slot, i) => (
        <Series.Sequence key={i} durationInFrames={slot.durationInFrames}>
          <SlotVideo slot={slot} />
        </Series.Sequence>
      ))}
    </Series>
  );
};
