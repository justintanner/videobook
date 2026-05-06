import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { MoreHorizontal } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';
import { Waveform } from './Waveform';
import { SlotHourglass } from './SlotHourglass';
import type { ClipState } from '@/components/sidebar/types';

function parseTimestamp(url: string): number {
  const match = url.match(/(\d+\.\d+)\.jpg$/);
  return match ? parseFloat(match[1]) : 0;
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
          <div className="w-full h-full bg-violet-500 shadow-[0_0_8px_var(--clip-domain-video),0_0_16px_var(--clip-domain-video)]" />
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
            className="w-72 h-auto rounded-lg border-2 border-violet-500 shadow-[0_0_24px_rgba(0,255,255,0.5),0_0_48px_rgba(0,255,255,0.2),0_8px_32px_rgba(0,0,0,0.6)]"
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
  renderStatus?: ClipState;
  flex?: number;
  onClick?: () => void;
  onAnimateCommand?: (text: string) => void;
}

function isRenderingStatus(status: ClipState | undefined): boolean {
  if (!status) return false;
  return status.startsWith('render-queued') || status.startsWith('rendering');
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
  renderStatus,
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

  const isRendering = isRenderingStatus(renderStatus);

  const slot = (
    <div
      className={cn(
        'relative h-full rounded cursor-pointer transition-all duration-150 group',
        isDragOver
          ? 'ring-2 ring-violet-500 shadow-[0_0_20px_rgba(0,255,255,0.2)]'
          : isActive
            ? 'ring-1 ring-violet-500'
            : hasContent
              ? 'border border-white/[0.08] hover:border-violet-500/30'
              : 'border border-dashed border-border/30 hover:border-border/50',
        hasContent && !isDragOver && !isRendering && 'cursor-grab active:cursor-grabbing',
        isRendering && 'clip-state-rendering',
      )}
      style={{ flex: `${flex} 1 0`, minWidth: '60px' }}
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Clipped inner content */}
      <div className="absolute inset-0 rounded overflow-hidden">
        {isRendering ? (
          <div className="absolute inset-0 bg-violet-500/5 flex items-center justify-center">
            <SlotHourglass />
          </div>
        ) : hasContent ? (
          <>
            {/* Dark background base */}
            <div className="absolute inset-0 bg-violet-500/5" />

            {/* Gradient overlay — lighter to not obscure waveform */}
            <div className="absolute inset-0 bg-gradient-to-b from-black/40 via-transparent to-black/50" />

            {/* Waveform — main background, vertically centered, ~70% height */}
            {waveform && waveform.length > 0 && (
              <Waveform
                data={waveform}
                className="absolute inset-x-0 top-[15%] bottom-[15%] text-violet-300"
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
      {hasContent && !isRendering && framePcts.length > 0 && (
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
          hasContent || isRendering ? 'text-white/80 drop-shadow-md' : 'text-muted-foreground/35'
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
      {assetId && !isRendering && (
        <div className="absolute bottom-1 left-1.5 z-20 max-w-[calc(100%-12px)]">
          <span className="text-[9px] font-mono text-white/40 truncate block leading-tight drop-shadow-sm">
            {assetId}
          </span>
        </div>
      )}

      {/* Active indicator */}
      {isActive && (
        <div className="absolute bottom-0 inset-x-0 h-0.5 bg-violet-500 shadow-[0_0_8px_var(--clip-domain-video)]" />
      )}

      {/* Drag overlay */}
      {isDragOver && (
        <div className="absolute inset-0 bg-violet-500/10 backdrop-blur-[1px] flex items-center justify-center">
          <span className="text-xs font-mono text-violet-300 font-bold">drop</span>
        </div>
      )}
    </div>
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{slot}</ContextMenuTrigger>
      {canClear && (
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => onAnimateCommand!(`/unassign ${label}`)}
            className="!flex flex-col !items-stretch gap-1.5 py-3 px-3 border-l-[3px] bg-white/[0.02] border-l-cyan-500/30 focus:!bg-white/[0.12] focus:!text-inherit focus:!border-l-[3px] focus:border-l-cyan-500/60"
          >
            <span className="text-sm font-semibold leading-none text-foreground">Clear Slot</span>
            <span className="font-mono text-muted-foreground text-xs tracking-wider leading-none">/unassign {label}</span>
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
