import { cn } from '@/lib/utils';

interface WaveformProps {
  data: number[];
  className?: string;
}

export function Waveform({ data, className }: WaveformProps) {
  const w = 100 / data.length;
  return (
    <div className={cn('relative', className)}>
      <svg
        viewBox="0 0 100 40"
        preserveAspectRatio="none"
        className="absolute inset-0 w-full h-full opacity-40 blur-[2px]"
      >
        {data.map((h, i) => {
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
        {data.map((h, i) => {
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
