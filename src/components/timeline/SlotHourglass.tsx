import { cn } from '@/lib/utils';

interface SlotHourglassProps {
  className?: string;
  label?: string;
}

export function SlotHourglass({ className, label = 'rendering' }: SlotHourglassProps) {
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-1 select-none pointer-events-none',
        className,
      )}
    >
      <svg
        viewBox="0 0 16 24"
        className="w-7 h-10 text-violet-300 drop-shadow-[0_0_6px_rgba(0,255,255,0.55)]"
        shapeRendering="crispEdges"
        aria-hidden="true"
      >
        <defs>
          <clipPath id="slot-hg-top">
            <polygon points="3,2 13,2 9,12 7,12" />
          </clipPath>
          <clipPath id="slot-hg-bot">
            <polygon points="7,12 9,12 13,22 3,22" />
          </clipPath>
        </defs>

        <rect x="2" y="1" width="12" height="1" fill="currentColor" />
        <rect x="2" y="22" width="12" height="1" fill="currentColor" />

        <polyline
          points="3,2 7,12 3,22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />
        <polyline
          points="13,2 9,12 13,22"
          fill="none"
          stroke="currentColor"
          strokeWidth="1"
        />

        <g clipPath="url(#slot-hg-top)">
          <rect className="slot-hg-sand-top" x="3" y="2" width="10" height="10" fill="currentColor" opacity="0.55" />
        </g>

        <g clipPath="url(#slot-hg-bot)">
          <rect className="slot-hg-sand-bot" x="3" y="22" width="10" height="0" fill="currentColor" opacity="0.55" />
        </g>

        <rect className="slot-hg-stream" x="7" y="11" width="2" height="3" fill="currentColor" />
      </svg>
      <span className="text-[8px] font-mono uppercase tracking-[0.18em] text-violet-300/70">
        {label}
      </span>
    </div>
  );
}
