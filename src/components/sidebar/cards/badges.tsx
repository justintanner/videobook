import type { MediaItem, OsgInfo } from '../types';
import { cardTone } from '@/theme/domains';
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

interface NewBadgeProps {
  item: MediaItem;
}

export function NewBadge({ item }: NewBadgeProps) {
  const visual = getCardVisualState(item);
  return (
    <div
      className="px-1.5 py-0.5 rounded text-black text-[9px] font-mono font-bold tracking-wider"
      style={{
        backgroundColor: visual.color,
        boxShadow: `0 0 8px ${colorWithAlpha(visual, 0.7)}`,
      }}
    >
      NEW
    </div>
  );
}

interface ArchiveBadgeProps {
  item: MediaItem;
}

export function ArchiveBadge({ item }: ArchiveBadgeProps) {
  const tone = cardTone('final');
  return (
    <div
      className="px-1.5 py-0.5 rounded text-black text-[9px] font-mono font-bold tracking-wider"
      style={{
        backgroundColor: tone.color,
        boxShadow: `0 0 8px rgba(${tone.rgb}, 0.7)`,
      }}
      title={item.archiveId ?? 'Archived'}
    >
      ARCHIVED
    </div>
  );
}

interface OsgBadgeProps {
  osg: OsgInfo;
  /** Fires when the badge is clicked; opens the OSG positioning overlay. */
  onClick?: () => void;
  /** Tailwind size classes for the badge box (default w-8 h-8). */
  sizeClassName?: string;
}

// Map a 9-anchor OSG position to corner placement classes, mirroring the server
// OsgOverlay placement so the badge previews where the graphic actually renders.
const OSG_BADGE_ANCHOR: Record<string, string> = {
  'top-left': 'top-1 left-1', 'top-center': 'top-1 left-1/2 -translate-x-1/2', 'top-right': 'top-1 right-1',
  'middle-left': 'top-1/2 left-1 -translate-y-1/2', 'middle-center': 'top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2', 'middle-right': 'top-1/2 right-1 -translate-y-1/2',
  'bottom-left': 'bottom-1 left-1', 'bottom-center': 'bottom-1 left-1/2 -translate-x-1/2', 'bottom-right': 'bottom-1 right-1',
};

export function OsgBadge({ osg, onClick, sizeClassName = 'w-8 h-8' }: OsgBadgeProps) {
  if (!osg || !osg.src) return null;
  const anchor = OSG_BADGE_ANCHOR[osg.position] ?? OSG_BADGE_ANCHOR['top-right'];
  return (
    <button
      type="button"
      tabIndex={-1}
      onClick={(e) => { e.stopPropagation(); onClick?.(); }}
      title="Edit on-screen graphic"
      className={`absolute z-40 ${sizeClassName} rounded-sm overflow-hidden border border-emerald-400/70 bg-black/40 shadow-[0_0_8px_rgba(110,231,183,0.5)] transition-transform hover:scale-110 ${anchor}`}
    >
      <img src={osg.src} alt="OSG" draggable={false} className="w-full h-full object-contain" />
    </button>
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
        className="min-w-6 h-6 px-1.5 inline-flex items-center justify-center rounded bg-black/70 backdrop-blur-md border text-[10px] font-mono font-bold"
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
