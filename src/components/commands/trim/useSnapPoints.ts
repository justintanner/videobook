import { useMemo } from 'react';
import type { MediaItem } from '@/components/sidebar/types';
import type { SnapMarker } from './types';

interface UseSnapPointsArgs {
  duration: number;
  markers: SnapMarker[];
  item: MediaItem | null;
  /**
   * Extra snap points injected by the active mode, e.g. the 10s cap line
   * computed from the current selection start. The cap moves with the
   * selection so it's recomputed on every render.
   */
  extraPoints?: number[];
}

export function useSnapPoints({
  duration,
  markers,
  item,
  extraPoints,
}: UseSnapPointsArgs): number[] {
  return useMemo(() => {
    if (duration <= 0) return [];
    const points = new Set<number>([0, duration]);
    for (const m of markers) points.add(m.timeSec);
    const frameUrls = item?.frameDirs?.original_frames;
    if (frameUrls && frameUrls.length > 0) {
      const count = Math.min(frameUrls.length, 8);
      for (let i = 0; i < count; i++) {
        points.add(((i + 0.5) / count) * duration);
      }
    }
    // 250ms grid
    for (let t = 0; t <= duration; t += 0.25) points.add(t);
    if (extraPoints) {
      for (const p of extraPoints) {
        if (p > 0 && p < duration) points.add(p);
      }
    }
    return Array.from(points).sort((a, b) => a - b);
  }, [markers, duration, item?.frameDirs?.original_frames, extraPoints]);
}
