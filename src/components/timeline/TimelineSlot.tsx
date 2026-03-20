import { useState, useCallback } from 'react';
import { cn } from '@/lib/utils';
import { MoreHorizontal, Eraser } from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
  ContextMenuItem,
} from '@/components/ui/context-menu';

interface TimelineSlotProps {
  label: string;
  isActive?: boolean;
  isDragOver?: boolean;
  hasContent?: boolean;
  thumbnailSrc?: string;
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
  thumbnailSrc,
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
    } catch {
      // ignore invalid drop data
    }
  }, [onAnimateCommand, label]);

  const showClearSlot = hasContent && onAnimateCommand;

  const clearSlotMenuItem = (
    <>
      <span className="font-mono text-muted-foreground/50 text-sm leading-none select-none mr-1">{'\u203A'}</span>
      <span className="font-mono font-bold text-xs tracking-wider leading-none flex-1">/clear-slot</span>
      <span className="ml-2 opacity-80 flex items-center"><Eraser className="h-3 w-3" /></span>
    </>
  );

  const slot = (
    <div
      className={cn(
        'relative h-full border bg-card/30 backdrop-blur-sm flex flex-col cursor-pointer transition-all duration-150 group overflow-hidden',
        isDragOver
          ? 'border-2 border-dashed border-primary bg-primary/10 scale-y-[1.02] shadow-[0_0_15px_rgba(0,255,255,0.3)]'
          : isActive
            ? 'border-primary bg-primary/5'
            : 'border-border/50 hover:border-primary/30',
        hasContent && !isDragOver && 'cursor-grab active:cursor-grabbing'
      )}
      style={{ flex: `${flex} 1 0`, minWidth: '60px' }}
      onClick={onClick}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Slot label badge */}
      <div className="absolute top-1.5 left-1.5 z-30">
        <span className="text-[10px] font-mono text-primary font-bold px-1.5 py-0.5 rounded bg-black/80 backdrop-blur-md border border-primary/15 whitespace-nowrap tracking-wide">
          {label}
        </span>
      </div>

      {/* Dropdown menu button */}
      <div className="absolute top-1.5 right-1.5 z-30">
        {showClearSlot ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                tabIndex={-1}
                className="w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-primary transition-colors duration-150 rounded hover:bg-black/40"
                onClick={(e) => e.stopPropagation()}
              >
                <MoreHorizontal className="w-3.5 h-3.5" />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" side="top">
              <DropdownMenuItem
                className="py-2.5"
                onSelect={() => onAnimateCommand(`/clear-slot ${label}`)}
              >
                {clearSlotMenuItem}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : (
          <button tabIndex={-1} className="w-5 h-5 flex items-center justify-center text-muted-foreground/40 hover:text-primary transition-colors duration-150 rounded hover:bg-black/40">
            <MoreHorizontal className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Content */}
      {hasContent ? (
        <div className="absolute inset-0 w-full h-full">
          <div className="absolute inset-0 bg-primary/5" />
          {thumbnailSrc && (
            <img src={thumbnailSrc} draggable={false} className="w-full h-full object-cover opacity-50" alt="" />
          )}
        </div>
      ) : (
        <div className="absolute inset-0 flex items-center justify-center opacity-15 group-hover:opacity-35 transition-opacity duration-200">
          <div className="w-7 h-7 border border-dashed border-foreground/60 rounded-full flex items-center justify-center">
            <span className="text-[10px] text-foreground/60">+</span>
          </div>
        </div>
      )}

      {/* Asset ID label */}
      {assetId && (
        <div className="absolute bottom-1.5 left-1.5 z-20 max-w-[calc(100%-12px)]">
          <span className="text-[9px] font-mono text-muted-foreground/60 px-1 py-0.5 rounded bg-black/70 truncate block leading-tight">
            {assetId}
          </span>
        </div>
      )}

      {/* Active Indicator */}
      {isActive && (
        <div className="absolute bottom-0 inset-x-0 h-0.5 bg-primary shadow-[0_0_10px_var(--color-primary)]" />
      )}
    </div>
  );

  if (!showClearSlot) return slot;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{slot}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={() => onAnimateCommand!(`/clear-slot ${label}`)}>
          {clearSlotMenuItem}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
