import { useEffect, useState } from 'react';
import type { OverlayProps } from './types';
import { colorWithAlpha, getCardVisualState } from '../stateColors';

interface ClockOverlayProps extends OverlayProps {
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

export function ClockOverlay({ item, startedAt }: ClockOverlayProps) {
  const visual = getCardVisualState(item);
  const colorRgba = (alpha: number) => colorWithAlpha(visual, alpha);
  const [fallbackStart] = useState(() => Date.now());
  const effectiveStart = startedAt ?? fallbackStart;

  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), TICK_MS);
    return () => clearInterval(id);
  }, []);

  const elapsedSec = Math.max(0, (now - effectiveStart) / 1000);
  const secondAngle = ((elapsedSec % 60) / 60) * 360;
  const minuteAngle = (((elapsedSec / 60) % 60) / 60) * 360;

  const ticks = Array.from({ length: 12 }, (_, i) => i);

  return (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 overflow-hidden">
      <svg
        width="68"
        height="68"
        viewBox="-34 -34 68 68"
        style={{ filter: `drop-shadow(0 0 8px ${visual.color})` }}
      >
        <circle cx="0" cy="0" r="30" fill="none" stroke={visual.color} strokeWidth="1.5" opacity="0.9" />
        <circle cx="0" cy="0" r="27" fill="none" stroke={colorRgba(0.25)} strokeWidth="0.5" />
        {ticks.map((i) => {
          const major = i % 3 === 0;
          return (
            <line
              key={i}
              x1="0"
              y1="-29"
              x2="0"
              y2={major ? -25 : -27}
              stroke={visual.color}
              strokeWidth={major ? 1.5 : 0.7}
              opacity={major ? 0.95 : 0.5}
              transform={`rotate(${i * 30})`}
            />
          );
        })}
        <line
          x1="0"
          y1="0"
          x2={handCoord(minuteAngle, 16, 'x')}
          y2={handCoord(minuteAngle, 16, 'y')}
          stroke={visual.color}
          strokeWidth="2.5"
          strokeLinecap="round"
        />
        <line
          x1="0"
          y1="0"
          x2={handCoord(secondAngle, 24, 'x')}
          y2={handCoord(secondAngle, 24, 'y')}
          stroke={visual.color}
          strokeWidth="1"
          strokeLinecap="round"
          opacity="0.85"
        />
        <circle cx="0" cy="0" r="2.5" fill={visual.color} />
        <circle cx="0" cy="0" r="0.8" fill="black" />
      </svg>
    </div>
  );
}
