import { useMemo } from 'react';
import type { TimelineConfig, Orientation } from '@/hooks/useTimeline';
import type { MediaItem } from '@/components/sidebar/types';
import type { TimelineSlotData, TimelineAudioOverlayData } from '@/remotion/TimelineComposition';
import {
  LANDSCAPE_WIDTH, LANDSCAPE_HEIGHT,
  PORTRAIT_WIDTH, PORTRAIT_HEIGHT,
  SQUARE_WIDTH, SQUARE_HEIGHT,
} from '@/remotion/constants';

const FPS = 30;

interface TimelinePreviewData {
  slots: TimelineSlotData[];
  audioClips: TimelineAudioOverlayData[];
  totalDurationInFrames: number;
  fps: number;
  compositionWidth: number;
  compositionHeight: number;
  slotOffsets: number[];
  ready: boolean;
  emptySlots: number[];
  missingRenders: string[];
}

function getDimensions(orientation: Orientation): { width: number; height: number } {
  switch (orientation) {
    case 'portrait': return { width: PORTRAIT_WIDTH, height: PORTRAIT_HEIGHT };
    case 'square': return { width: SQUARE_WIDTH, height: SQUARE_HEIGHT };
    default: return { width: LANDSCAPE_WIDTH, height: LANDSCAPE_HEIGHT };
  }
}

export function computeTimelinePreview(
  timeline: TimelineConfig | undefined,
  mediaItems: MediaItem[],
  projectSlug: string | null | undefined,
  orientation: Orientation,
): TimelinePreviewData {
  const empty: TimelinePreviewData = {
    slots: [],
    audioClips: [],
    totalDurationInFrames: 1,
    fps: FPS,
    compositionWidth: LANDSCAPE_WIDTH,
    compositionHeight: LANDSCAPE_HEIGHT,
    slotOffsets: [],
    ready: false,
    emptySlots: [],
    missingRenders: [],
  };

  if (!timeline || !projectSlug) return empty;

  const { width, height } = getDimensions(orientation);
  const slots: TimelineSlotData[] = [];
  const slotOffsets: number[] = [];
  const emptySlots: number[] = [];
  const missingRenders: string[] = [];
  let cumulativeFrames = 0;

  for (let i = 0; i < timeline.slots.length; i++) {
    const timelineSlot = timeline.slots[i];
    // One offset per timeline slot (empty ones included) so indices line up
    // with the displayed slot order when seeking or drawing boundaries.
    slotOffsets.push(cumulativeFrames);
    if (!timelineSlot.slug) {
      emptySlots.push(i);
      continue;
    }

    const item = mediaItems.find(m => m.id === timelineSlot.slug);
    if (!item) {
      emptySlots.push(i);
      continue;
    }

    const hasRender = item.renders?.includes(orientation);
    if (!hasRender) {
      missingRenders.push(item.id);
    }

    const durationInFrames = Math.max(1, Math.round((item.duration ?? 0) * FPS));
    const file = hasRender ? `${orientation}.mp4` : 'original.mp4';
    const src = `/files/${projectSlug}/${item.id}/${file}`;

    slots.push({
      src,
      durationInFrames,
      volume: timelineSlot.volume ?? 100,
      fadeIn: timelineSlot.audioFadeIn ?? 0,
      fadeOut: timelineSlot.audioFadeOut ?? 0,
    });
    cumulativeFrames += durationInFrames;
  }

  const totalDurationInFrames = Math.max(1, cumulativeFrames);
  const ready = slots.length > 0;

  const audioClips: TimelineAudioOverlayData[] = [];
  for (const clip of timeline.audio ?? []) {
    const item = mediaItems.find((m) => m.id === clip.slug);
    if (!item) continue;
    const src = item.filePath || `/files/${projectSlug}/${item.id}/original.mp3`;
    audioClips.push({
      id: clip.id,
      src,
      startFrame: clip.startFrame,
      durationFrames: clip.durationFrames,
      volume: clip.volume ?? 100,
      fadeIn: clip.fadeIn ?? 0,
      fadeOut: clip.fadeOut ?? 0,
    });
  }

  return {
    slots,
    audioClips,
    totalDurationInFrames,
    fps: FPS,
    compositionWidth: width,
    compositionHeight: height,
    slotOffsets,
    ready,
    emptySlots,
    missingRenders,
  };
}

export function useTimelinePreview(
  timeline: TimelineConfig | undefined,
  mediaItems: MediaItem[],
  projectSlug: string | null | undefined,
  orientation: Orientation,
): TimelinePreviewData {
  return useMemo(
    () => computeTimelinePreview(timeline, mediaItems, projectSlug, orientation),
    [timeline, mediaItems, projectSlug, orientation],
  );
}
