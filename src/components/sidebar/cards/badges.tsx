import type { MediaItem } from '../types';
import { colorWithAlpha, getCardVisualState } from '../stateColors';

interface SlugBadgeProps {
  item: MediaItem;
  muted?: boolean;
}

export function SlugBadge({ item, muted }: SlugBadgeProps) {
  const visual = getCardVisualState(item);

  return (
    <div className="absolute bottom-2 left-2 right-2 z-40 flex justify-start pointer-events-none">
      <span
        className="max-w-full text-xs font-mono font-bold truncate px-2 py-1 rounded bg-black/85 backdrop-blur-md border"
        style={{
          borderColor: visual.border,
          color: visual.color,
          opacity: muted ? 0.72 : 1,
          textShadow: `0 0 8px ${visual.color}`,
        }}
        title={item.slug}
      >
        {item.slug}
      </span>
    </div>
  );
}

interface DurationBadgeProps {
  item: MediaItem;
  duration: string;
  muted?: boolean;
}

export function DurationBadge({ item, duration, muted }: DurationBadgeProps) {
  const visual = getCardVisualState(item);

  return (
    <div className="absolute top-2 left-2 z-20">
      <div
        className="px-2 py-1 rounded bg-black/70 backdrop-blur-md border text-[10px] font-mono font-bold"
        style={{
          borderColor: muted ? visual.border : colorWithAlpha(visual, 0.32),
          color: visual.color,
          opacity: muted ? 0.72 : 0.9,
          boxShadow: `0 0 8px -2px ${visual.color}`,
        }}
      >
        {duration}
      </div>
    </div>
  );
}

export function NewBadge() {
  return (
    <div
      className="absolute top-2 right-2 z-30 px-1.5 py-0.5 rounded bg-primary text-black text-[9px] font-mono font-bold tracking-wider shadow-[0_0_8px_var(--color-primary)] pointer-events-none"
    >
      NEW
    </div>
  );
}

interface ResolutionBadgeProps {
  item: MediaItem;
  width: number;
  height: number;
}

export function ResolutionBadge({ item, width, height }: ResolutionBadgeProps) {
  const visual = getCardVisualState(item);

  return (
    <div className="absolute top-2 left-2 z-20">
      <div
        className="px-2 py-1 rounded bg-black/70 backdrop-blur-md border text-[10px] font-mono font-bold"
        style={{
          borderColor: colorWithAlpha(visual, 0.32),
          color: visual.color,
          boxShadow: `0 0 8px -2px ${visual.color}`,
        }}
      >
        {width}x{height}
      </div>
    </div>
  );
}
