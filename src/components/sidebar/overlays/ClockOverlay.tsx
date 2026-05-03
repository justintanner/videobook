import { useEffect, useState } from 'react';
import type { OverlayProps } from './types';
import { colorWithAlpha, getCardVisualState } from '../stateColors';
import { AnimatedBackground } from './AnimatedBackground';

interface ClockOverlayProps extends OverlayProps {
  /** State name shown next to the clock, e.g. "GENERATING". */
  label: string;
  /** Unix ms when the work being timed started. When omitted, the clock
   *  starts from the moment the overlay first mounts (effectively the
   *  moment the asset entered this state in the UI). */
  startedAt?: number | null;
}

const TICK_MS = 250;

function handCoord(angleDeg: number, length: number, axis: 'x' | 'y'): number {
  const rad = (angleDeg * Math.PI) / 180;
  return axis === 'x' ? Math.sin(rad) * length : -Math.cos(rad) * length;
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
  return `${minutes}:${pad(seconds)}`;
}

export function ClockOverlay({ item, label, startedAt }: ClockOverlayProps) {
  const visual = getCardVisualState(item);
  const colorRgba = (alpha: number) => colorWithAlpha(visual, alpha);
  const [fallbackStart] = useState(() => Date.now());
  const effectiveStart = startedAt ?? fallbackStart;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const elapsedMs = Math.max(0, now - effectiveStart);
  const elapsedSec = elapsedMs / 1000;
  const secondAngle = ((elapsedSec % 60) / 60) * 360;
  const minuteAngle = (((elapsedSec / 60) % 60) / 60) * 360;
  const elapsedLabel = formatElapsed(elapsedMs);

  const ticks = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="absolute inset-0 z-30 bg-black/70 overflow-hidden">
      <AnimatedBackground visual={visual} fall={label === 'DOWNLOADING'} />
      <div
        className="absolute inset-x-0 top-4 flex items-start justify-center gap-3"
        style={{ color: visual.color, filter: `drop-shadow(0 0 6px ${visual.color})` }}
      >
        <svg width="52" height="52" viewBox="-26 -26 52 52">
          <circle cx="0" cy="0" r="23" fill="none" stroke={visual.color} strokeWidth="1.4" opacity="0.9" />
          <circle cx="0" cy="0" r="20.5" fill="none" stroke={colorRgba(0.25)} strokeWidth="0.5" />
          {ticks.map((i) => {
            const major = i % 3 === 0;
            return (
              <line
                key={i}
                x1="0"
                y1="-22"
                x2="0"
                y2={major ? -19 : -20.5}
                stroke={visual.color}
                strokeWidth={major ? 1.3 : 0.6}
                opacity={major ? 0.95 : 0.5}
                transform={`rotate(${i * 30})`}
              />
            );
          })}
          <line
            x1="0"
            y1="0"
            x2={handCoord(minuteAngle, 12, 'x')}
            y2={handCoord(minuteAngle, 12, 'y')}
            stroke={visual.color}
            strokeWidth="2"
            strokeLinecap="round"
          />
          <line
            x1="0"
            y1="0"
            x2={handCoord(secondAngle, 18, 'x')}
            y2={handCoord(secondAngle, 18, 'y')}
            stroke={visual.color}
            strokeWidth="0.9"
            strokeLinecap="round"
            opacity="0.85"
          />
          <circle cx="0" cy="0" r="2" fill={visual.color} />
          <circle cx="0" cy="0" r="0.7" fill="black" />
        </svg>
        <div className="flex flex-col font-mono leading-none">
          <span className="text-[8px] font-bold tracking-[0.2em] opacity-90">{label}</span>
          <span className="text-[15px] font-bold tabular-nums mt-1.5">{elapsedLabel}</span>
        </div>
      </div>
    </div>
  );
}
