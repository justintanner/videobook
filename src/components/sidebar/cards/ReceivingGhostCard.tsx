import { cn } from '@/lib/utils';

interface ReceivingGhostCardProps {
  filename: string;
}

export function ReceivingGhostCard({ filename }: ReceivingGhostCardProps) {
  const displayName = filename.length > 20 ? `${filename.slice(0, 17)}...` : filename;

  return (
    <div
      className={cn(
        'relative h-32 w-full overflow-hidden clip-corner-br',
        'bg-card/90 backdrop-blur-sm',
        'border border-primary/20',
        'v4-hud-glow'
      )}
    >
      {/* Hexagonal grid background pattern */}
      <svg className="absolute inset-0 w-full h-full pointer-events-none opacity-[0.06]">
        <defs>
          <pattern id="v4-hex" width="28" height="48" patternUnits="userSpaceOnUse" patternTransform="scale(0.8)">
            <path
              d="M14 0 L28 8 L28 24 L14 32 L0 24 L0 8 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              className="text-primary"
            />
            <path
              d="M14 16 L28 24 L28 40 L14 48 L0 40 L0 24 Z"
              fill="none"
              stroke="currentColor"
              strokeWidth="1"
              className="text-primary"
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#v4-hex)" />
      </svg>

      {/* Hex pulse overlay */}
      <div className="absolute inset-0 v4-hex-pulse pointer-events-none" />

      {/* Scanline overlay */}
      <div className="absolute inset-0 pointer-events-none opacity-[0.04]"
        style={{
          backgroundImage: 'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(0,255,255,0.4) 2px, rgba(0,255,255,0.4) 3px)',
        }}
      />

      {/* Radar / scanner circle — top-right corner */}
      <div className="absolute top-2 right-3 w-10 h-10">
        {/* Outer ring */}
        <svg className="absolute inset-0 w-full h-full" viewBox="0 0 40 40">
          <circle cx="20" cy="20" r="17" fill="none" stroke="var(--color-primary)" strokeWidth="0.5" opacity="0.3" />
          <circle cx="20" cy="20" r="12" fill="none" stroke="var(--color-primary)" strokeWidth="0.5" opacity="0.2" />
          <circle cx="20" cy="20" r="7" fill="none" stroke="var(--color-primary)" strokeWidth="0.5" opacity="0.15" />
          {/* Crosshair */}
          <line x1="20" y1="2" x2="20" y2="38" stroke="var(--color-primary)" strokeWidth="0.3" opacity="0.2" />
          <line x1="2" y1="20" x2="38" y2="20" stroke="var(--color-primary)" strokeWidth="0.3" opacity="0.2" />
        </svg>
        {/* Rotating sweep arm */}
        <svg className="absolute inset-0 w-full h-full v4-radar-sweep" viewBox="0 0 40 40">
          <defs>
            <linearGradient id="v4-sweep-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0%" stopColor="var(--color-primary)" stopOpacity="0" />
              <stop offset="100%" stopColor="var(--color-primary)" stopOpacity="0.6" />
            </linearGradient>
          </defs>
          <line x1="20" y1="20" x2="20" y2="3" stroke="url(#v4-sweep-grad)" strokeWidth="1.5" strokeLinecap="round" />
        </svg>
        {/* Blip on the radar */}
        <div className="absolute w-1 h-1 rounded-full bg-green-500 shadow-[0_0_4px_rgba(34,197,94,0.8)] v4-radar-blip"
          style={{ top: '30%', left: '60%' }}
        />
      </div>

      {/* Content */}
      <div className="relative h-full flex flex-col justify-between p-3 z-10">
        {/* Top row: FILE TRANSFER label */}
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1.5">
            <div className="w-1.5 h-1.5 rounded-full bg-green-500 shadow-[0_0_6px_rgba(34,197,94,0.6)] v4-status-blink" />
            <span className="font-mono text-[10px] tracking-[0.2em] text-primary/90 uppercase">
              File Transfer
            </span>
          </div>
        </div>

        {/* Middle: Filename + status readouts */}
        <div className="flex flex-col gap-1">
          <span className="font-sans text-sm text-foreground truncate leading-tight" title={filename}>
            {displayName}
          </span>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[9px] text-green-500/80 tracking-wider">
              STATUS: ACTIVE
            </span>
            <span className="font-mono text-[9px] text-primary/50 tracking-wider">
              2.4 MB/s
            </span>
          </div>
        </div>

        {/* Bottom: Chevron flow bar */}
        <div className="flex items-center gap-2">
          {/* Chevron stream */}
          <div className="flex-1 h-3 overflow-hidden relative bg-muted/20 border border-primary/10">
            <div className="absolute inset-y-0 flex items-center v4-chevron-flow whitespace-nowrap">
              <span className="font-mono text-[9px] text-primary/50 tracking-[0.15em]">
                {'>>> >>> >>> >>> >>> >>> >>> >>>'}
              </span>
            </div>
          </div>
          {/* Transfer percentage */}
          <span className="font-mono text-[9px] text-primary/70 v4-pct-flicker">
            RCV
          </span>
        </div>
      </div>

      {/* Decorative corner tick marks */}
      <div className="absolute top-1 left-1 w-4 h-[1px] bg-primary/30" />
      <div className="absolute top-1 left-1 w-[1px] h-4 bg-primary/30" />
      <div className="absolute bottom-1 left-1 w-4 h-[1px] bg-primary/30" />
      <div className="absolute bottom-1 left-1 w-[1px] h-4 bg-primary/30" />

      {/* SVG corner accent line from CardShell */}
      <svg
        className="absolute transition-opacity pointer-events-none z-40 opacity-100"
        width="14" height="14" viewBox="0 0 14 14"
        style={{ bottom: '-5px', right: '-2px' }}
      >
        <line x1="0" y1="14" x2="14" y2="0" stroke="var(--color-primary)" strokeWidth="2" />
      </svg>
    </div>
  );
}
