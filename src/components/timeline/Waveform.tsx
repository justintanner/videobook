import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { downsamplePeaks } from '@/lib/waveform';

interface WaveformProps {
  data: number[];
  className?: string;
}

// The strip is stretched with preserveAspectRatio="none" into a small area, so
// bars beyond screen resolution add DOM nodes with no visible benefit. Cap the
// bar count so a 1000-sample waveform doesn't emit 2000 <rect> nodes per clip.
const MAX_BARS = 120;

export function Waveform({ data, className }: WaveformProps) {
  const bars = useMemo(() => downsamplePeaks(data, MAX_BARS), [data]);
  const w = 100 / bars.length;
  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full opacity-40 blur-[2px]"
      >
        {bars.map((h, i) => {
          const barH = Math.max(2, h * 38);
          return (
            <rect
              key={i}
              x={i * w}
              y={40 - barH}
              width={w * 0.7}
              height={barH}
              rx={0.5}
              fill="currentColor"
            />
          );
        })}
      </svg>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="relative w-full h-full"
      >
        {bars.map((h, i) => {
          const barH = Math.max(2, h * 38);
          const opacity = 0.3 + h * 0.7;
          return (
            <rect
              key={i}
              x={i * w}
              y={40 - barH}
              width={w * 0.7}
              height={barH}
              rx={0.5}
              fill="currentColor"
              opacity={opacity}
            />
          );
        })}
      </svg>
    </div>
  );
}
