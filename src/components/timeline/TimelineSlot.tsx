import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { MoreHorizontal, Eraser } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';

function parseTimestamp(url: string): number {
  const match = url.match(/(\d+\.\d+)\.jpg$/);
  return match ? parseFloat(match[1]) : 0;
}

function Waveform({ data, className }: { data: number[]; className?: string }) {
  const w = 100 / data.length;
  return (
    <div className={cn('relative', className)}>
      {/* Glow layer */}
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
      {/* Sharp layer */}
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

function MicroThumb({ url, pct }: { url: string; pct: number }) {
  const [hovered, setHovered] = useState(false);
  const thumbRef = useRef<HTMLDivElement>(null);
  const [popupPos, setPopupPos] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (hovered && thumbRef.current) {
      const rect = thumbRef.current.getBoundingClientRect();
      setPopupPos({ x: rect.left + rect.width / 2, y: rect.top });
    } else {
      setPopupPos(null);
    }
  }, [hovered]);

  return (
    <div
      ref={thumbRef}
      className="absolute top-1/2 z-20"
      style={{ left: `${pct}%`, transform: 'translate(-50%, -50%)' }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* Glowing vertical beam (stays in-flow) */}
      {hovered && (
        <div
          className="absolute bottom-0 left-1/2 -translate-x-1/2 w-[2px] pointer-events-none"
          style={{ height: '400%' }}
        >
          <div className="w-full h-full bg-primary shadow-[0_0_8px_var(--color-primary),0_0_16px_var(--color-primary)]" />
        </div>
      )}
      {/* Large preview — portalled to body to escape overflow-hidden */}
      {hovered && popupPos && createPortal(
        <div
          className="pointer-events-none"
          style={{
            position: 'fixed',
            left: popupPos.x,
            top: popupPos.y,
            transform: 'translate(-50%, -100%)',
            marginTop: -12,
            zIndex: 9999,
          }}
        >
          <img
            src={url}
            alt=""
            className="w-72 h-auto rounded-lg border-2 border-primary shadow-[0_0_24px_rgba(0,255,255,0.5),0_0_48px_rgba(0,255,255,0.2),0_8px_32px_rgba(0,0,0,0.6)]"
          />
        </div>,
        document.body,
      )}
      {/* Small thumbnail */}
      <img
        src={url}
        alt=""
        className={cn(
          'h-7 w-auto rounded-sm transition-all duration-150',
          hovered
            ? 'opacity-0'
            : 'opacity-50 hover:opacity-80 drop-shadow-[0_1px_3px_rgba(0,0,0,0.6)]'
        )}
      />
    </div>
  );
}

interface TimelineSlotProps {
  label: string;
  isActive?: boolean;
  isDragOver?: boolean;
  hasContent?: boolean;
  frameUrls?: string[];
  waveform?: number[];
  duration?: number;
  assetId?: string;
  flex?: number;
  onClick?: () => void;
  onAnimateCommand?: (text: string) => void;
}

export function TimelineSlot({
  label,
  isActive = false,
  isDragOver: isDragOverProp = false,
  hasContent = false,
  frameUrls,
  waveform,
  duration,
  assetId,
  flex = 1,
  onClick,
  onAnimateCommand,
}: TimelineSlotProps) {
  const [isDragOverLocal, setIsDragOverLocal] = useState(false);
  const isDragOver = isDragOverProp || isDragOverLocal;

  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!onAnimateCommand) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setIsDragOverLocal(true);
  }, [onAnimateCommand]);

  const handleDragLeave = useCallback(() => {
    setIsDragOverLocal(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOverLocal(false);
    if (!onAnimateCommand) return;
    try {
      const data = JSON.parse(e.dataTransfer.getData('application/json'));
      if (data?.id) {
        onAnimateCommand(`/assign @${data.id} ${label}`);
      }
    } catch { /* ignore */ }
  }, [onAnimateCommand, label]);

  const canClear = hasContent && onAnimateCommand;

  const handleMenuClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const target = e.currentTarget;
    const x = e.clientX;
    const y = e.clientY;
    setTimeout(() => {
      target.dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: x, clientY: y })
      );
    }, 0);
  }, []);

  const framePcts = useMemo(() => {
    if (!frameUrls || frameUrls.length === 0 || !duration || duration <= 0) return [];
    return frameUrls.map((url) => ({
      url,
      pct: Math.min(95, Math.max(5, (parseTimestamp(url) / duration) * 100)),
    }));
  }, [frameUrls, duration]);

  const slot = (
    <div
      className={cn(
        'relative h-full rounded cursor-pointer transition-all duration-150 group',
        isDragOver
          ? 'ring-2 ring-primary shadow-[0_0_20px_rgba(0,255,255,0.2)]'
          : isActive
            ? 'ring-1 ring-primary'
            : hasContent
              ? 'border border-white/[0.08] hover:border-primary/30'
              : 'border border-dashed border-border/30 hover:border-border/50',
        hasContent && !isDragOver && 'cursor-grab active:cursor-grabbing'
      )}
      style={{ flex: `${flex} 1 0`, minWidth: '60px' }}
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Clipped inner content */}
      <div className="absolute inset-0 rounded overflow-hidden">
        {hasContent ? (
          <>
            {/* Dark background base */}
            <div className="absolute inset-0 bg-primary/5" />

            {/* Gradient overlay — lighter to not obscure waveform */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/50" />

            {/* Waveform — main background, vertically centered, ~70% height */}
            {waveform && waveform.length > 0 && (
              <Waveform
                data={waveform}
                className="absolute inset-x-0 top-[15%] bottom-[15%] text-primary"
              />
            )}

          </>
        ) : (
          <div className="absolute inset-0 bg-card/10 flex items-center justify-center">
            <span className="text-[10px] font-mono text-muted-foreground/20 group-hover:text-muted-foreground/35 transition-colors select-none">
              empty
            </span>
          </div>
        )}
      </div>

      {/* Micro frame thumbnails — outside overflow-hidden so hover previews escape */}
      {hasContent && framePcts.length > 0 && (
        <div className="absolute inset-x-3 bottom-0 top-0 z-20">
          {framePcts.map(({ url, pct }) => (
            <MicroThumb key={url} url={url} pct={pct} />
          ))}
        </div>
      )}

      {/* Label — top-left slot tag */}
      <div className="absolute top-1 left-1.5 z-30">
        <span className={cn(
          'text-xs font-mono font-bold tracking-wide leading-none',
          hasContent ? 'text-white/80 drop-shadow-md' : 'text-muted-foreground/35'
        )}>
          {label}
        </span>
      </div>

      {/* Menu button — top-right, hover-reveal */}
      <div className="absolute top-0.5 right-0.5 z-30">
        <button
          tabIndex={-1}
          className={cn(
            'w-5 h-5 flex items-center justify-center rounded transition-colors',
            'opacity-0 group-hover:opacity-100',
            hasContent
              ? 'text-white/50 hover:text-white hover:bg-white/10'
              : 'text-muted-foreground/40 hover:text-muted-foreground'
          )}
          onClick={handleMenuClick}
        >
          <MoreHorizontal className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Asset ID — bottom-left */}
      {assetId && (
        <div className="absolute bottom-1 left-1.5 z-20 max-w-[calc(100%-12px)]">
          <span className="text-[9px] font-mono text-white/40 truncate block leading-tight drop-shadow-sm">
            {assetId}
          </span>
        </div>
      )}

      {/* Active indicator */}
      {isActive && (
        <div className="absolute bottom-0 inset-x-0 h-0.5 bg-primary shadow-[0_0_8px_var(--color-primary)]" />
      )}

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-primary/10 backdrop-blur-[1px] flex items-center justify-center">
          <span className="text-xs font-mono text-primary font-bold">drop</span>
        </div>
      )}
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{slot}</ContextMenuTrigger>
      {canClear && (
        <ContextMenuContent>
          <ContextMenuItem onSelect={() => onAnimateCommand!(`/clear-slot ${label}`)}>
            <span className="font-mono text-muted-foreground/50 text-sm leading-none select-none mr-1">{'\u203A'}</span>
            <span className="font-mono font-bold text-xs tracking-wider leading-none flex-1">/clear-slot</span>
            <span className="ml-2 opacity-80 flex items-center"><Eraser className="h-3 w-3" /></span>
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
