import { AudioLines, Compass, FileText, Film, ImageIcon, User } from 'lucide-react';
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

function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds <= 0) return null;
  if (seconds >= 60) {
    const total = Math.round(seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  if (Number.isInteger(seconds)) return `${seconds}s`;
  const trimmed = seconds.toFixed(2).replace(/\.?0+$/, '');
  return `${trimmed}s`;
}

interface DurationBadgeProps {
  item: MediaItem;
  seconds: number | null | undefined;
  muted?: boolean;
}

export function DurationBadge({ item, seconds, muted }: DurationBadgeProps) {
  const visual = getCardVisualState(item);
  const duration = formatDuration(seconds);
  if (!duration) return null;

  return (
    <div className="absolute top-2 left-2 z-20">
      <div
        className="min-w-6 h-6 px-1.5 inline-flex items-center justify-center rounded bg-black/70 backdrop-blur-md border text-[10px] font-mono font-bold"
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

function NewIcon({ type }: { type: MediaItem['type'] }) {
  const className = 'w-3 h-3';
  switch (type) {
    case 'audio': return <AudioLines className={className} />;
    case 'script': return <FileText className={className} />;
    case 'plan': return <Compass className={className} />;
    case 'video': return <Film className={className} />;
    case 'image': return <ImageIcon className={className} />;
    case 'character': return <User className={className} />;
    case 'final': return <Film className={className} />;
  }
}

interface NewBadgeProps {
  item: MediaItem;
}

export function NewBadge({ item }: NewBadgeProps) {
  const visual = getCardVisualState(item);
  return (
    <div
      className="absolute top-2 right-2 z-30 w-5 h-5 inline-flex items-center justify-center rounded bg-black/70 backdrop-blur-md border pointer-events-none"
      style={{
        borderColor: colorWithAlpha(visual, 0.32),
        color: visual.color,
        boxShadow: `0 0 8px -2px ${visual.color}`,
      }}
    >
      <NewIcon type={item.type} />
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
