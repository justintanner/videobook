import { useEffect, useState } from 'react';
import { AudioLines, Compass, FileText, Film, ImageIcon, User } from 'lucide-react';
import type { OverlayProps } from './types';
import { getCardVisualState } from '../stateColors';
import { AnimatedBackground } from './AnimatedBackground';
import type { MediaItem } from '../types';

interface ClockOverlayProps extends OverlayProps {
  /** State name shown next to the icon, e.g. "GENERATING". */
  label: string;
  /** Unix ms when the work being timed started. When omitted, the timer
   *  starts from the moment the overlay first mounts (effectively the
   *  moment the asset entered this state in the UI). */
  startedAt?: number | null;
}

const TICK_MS = 250;

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

function TypeIcon({ type }: { type: MediaItem['type'] }) {
  const className = 'w-10 h-10';
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

export function ClockOverlay({ item, label, startedAt }: ClockOverlayProps) {
  const visual = getCardVisualState(item);
  const [fallbackStart] = useState(() => Date.now());
  const effectiveStart = startedAt ?? fallbackStart;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const elapsedLabel = formatElapsed(Math.max(0, now - effectiveStart));

  return (
    <div className="absolute inset-0 z-30 bg-black/70 overflow-hidden">
      <AnimatedBackground visual={visual} fall={label === 'DOWNLOADING'} />
      <div
        className="absolute inset-0 pb-10 flex items-center justify-center gap-3"
        style={{ color: visual.color, filter: `drop-shadow(0 0 6px ${visual.color})` }}
      >
        <TypeIcon type={item.type} />
        <div className="flex flex-col font-mono leading-none">
          <span className="text-[8px] font-bold tracking-[0.2em] opacity-90">{label}</span>
          <span className="text-[15px] font-bold tabular-nums mt-1.5">{elapsedLabel}</span>
        </div>
      </div>
    </div>
  );
}
