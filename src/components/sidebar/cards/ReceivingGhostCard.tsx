import { cn } from '@/lib/utils';

interface ReceivingGhostCardProps {
  filename: string;
}

export function ReceivingGhostCard({ filename }: ReceivingGhostCardProps) {
  const displayName = filename.length > 24 ? `${filename.slice(0, 21)}...` : filename;

  return (
    <div
      className={cn(
        'relative h-24 w-full mb-4 overflow-hidden rounded',
        'border border-primary/30 bg-card/80 backdrop-blur-sm',
        'receiving-border-glow'
      )}
    >
      {/* Scanline sweep effect */}
      <div className="absolute inset-0 receiving-scanline-sweep pointer-events-none" />

      {/* HUD corner brackets */}
      <div className="absolute top-2 left-2 w-3 h-3 border-t border-l border-primary/50" />
      <div className="absolute top-2 right-2 w-3 h-3 border-t border-r border-primary/50" />
      <div className="absolute bottom-2 left-2 w-3 h-3 border-b border-l border-primary/50" />
      <div className="absolute bottom-2 right-2 w-3 h-3 border-b border-r border-primary/50" />

      {/* Content container */}
      <div className="relative h-full flex flex-col justify-between p-3">
        {/* Top row: RECEIVING label with blinking cursor */}
        <div className="flex items-center justify-between">
          <span className="font-mono text-xs tracking-wider text-primary/80 receiving-text-flicker">
            RECEIVING<span className="receiving-cursor-blink">_</span>
          </span>
          <span className="font-mono text-[10px] text-muted-foreground uppercase">
            FILE
          </span>
        </div>

        {/* Middle: Filename */}
        <div className="flex-1 flex items-center">
          <span className="font-sans text-sm text-foreground truncate" title={filename}>
            {displayName}
          </span>
        </div>

        {/* Bottom: Segmented progress indicator */}
        <div className="flex gap-1">
          <div className="flex-1 h-1.5 bg-muted/50 rounded-sm overflow-hidden">
            <div className="h-full bg-primary/60 receiving-segment-fill" style={{ animationDelay: '0ms' }} />
          </div>
          <div className="flex-1 h-1.5 bg-muted/50 rounded-sm overflow-hidden">
            <div className="h-full bg-primary/60 receiving-segment-fill" style={{ animationDelay: '200ms' }} />
          </div>
          <div className="flex-1 h-1.5 bg-muted/50 rounded-sm overflow-hidden">
            <div className="h-full bg-primary/60 receiving-segment-fill" style={{ animationDelay: '400ms' }} />
          </div>
        </div>
      </div>
    </div>
  );
}
