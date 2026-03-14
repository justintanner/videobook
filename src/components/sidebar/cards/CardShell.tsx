import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
} from '@/components/ui/context-menu';
import type { MediaItem, ClipState } from '../types';
import {
  UploadingOverlay,
  GeneratingOverlay,
  RenderingOverlay,
  ElfBuildingOverlay,
  DownloadingOverlay,
  UntranscribedOverlay,
  TranscribingOverlay,
  CorruptOverlay,
  FailedOverlay,
  LoadingOverlay,
} from '../overlays';

export interface CardShellProps {
  item: MediaItem;
  children: ReactNode;
  contextMenuContent?: ReactNode;
  onClick?: () => void;
}

function isRenderingState(status: string): boolean {
  return status === 'rendering' ||
    status === 'rendering-landscape' ||
    status === 'rendering-portrait' ||
    status === 'render-queued' ||
    status === 'render-queued-landscape' ||
    status === 'render-queued-portrait' ||
    status === 'rendering-square' ||
    status === 'render-queued-square';
}

function StateOverlay({ item }: { item: MediaItem }) {
  const status = item.status;
  const type = item.type;
  if (!status) return null;

  if (status === 'uploading' && type !== 'final') return <UploadingOverlay item={item} />;
  if (status === 'generating' && type !== 'final') return <GeneratingOverlay item={item} />;
  if (isRenderingState(status)) return type === 'final' ? <ElfBuildingOverlay item={item} /> : <RenderingOverlay item={item} />;
  if (status === 'downloading' && type !== 'final') return <DownloadingOverlay item={item} />;
  if (status === 'transcribing' && (type === 'video' || type === 'audio')) return <TranscribingOverlay item={item} />;
  if (status === 'untranscribed' && (type === 'video' || type === 'audio')) return <UntranscribedOverlay item={item} />;
  if (status === 'corrupt' && type !== 'final') return <CorruptOverlay item={item} />;
  if (status === 'error') return <FailedOverlay item={item} />;
  if (status === 'loading') return <LoadingOverlay item={item} />;

  return null;
}

const stateClassMap: Partial<Record<ClipState, string>> = {
  uploading: 'clip-state-uploading cursor-wait',
  generating: 'clip-state-generating cursor-wait',
  rendering: 'clip-state-rendering cursor-wait',
  'rendering-landscape': 'clip-state-rendering cursor-wait',
  'rendering-portrait': 'clip-state-rendering cursor-wait',
  'render-queued': 'clip-state-rendering cursor-wait',
  'render-queued-landscape': 'clip-state-rendering cursor-wait',
  'render-queued-portrait': 'clip-state-rendering cursor-wait',
  'rendering-square': 'clip-state-rendering cursor-wait',
  'render-queued-square': 'clip-state-rendering cursor-wait',
  downloading: 'clip-state-downloading cursor-wait',
  untranscribed: 'clip-state-untranscribed cursor-wait',
  transcribing: 'clip-state-transcribing cursor-pointer',
  corrupt: 'clip-state-corrupt cursor-pointer',
  loading: 'clip-state-loading cursor-wait',
};

function getCornerStrokeColor(status: ClipState | undefined, isFinal: boolean, isError: boolean, isReady: boolean): string {
  if (isError) return '#ef4444';
  if (isFinal && (isReady || isRenderingState(status ?? ''))) return '#fbbf24';
  if (isReady) return 'var(--color-primary)';

  const stateColors: Partial<Record<ClipState, string>> = {
    uploading: 'rgba(0, 255, 255, 0.7)',
    generating: 'rgba(34, 197, 94, 0.7)',
    rendering: 'rgba(0, 255, 255, 0.7)',
    downloading: 'rgba(139, 92, 246, 0.7)',
    untranscribed: 'rgba(0, 255, 255, 0.4)',
    transcribing: 'rgba(0, 255, 255, 0.7)',
    corrupt: 'rgba(255, 0, 128, 0.7)',
    loading: 'rgba(0, 255, 255, 0.5)',
  };

  return (status && stateColors[status]) ?? 'var(--color-primary)';
}

export function CardShell({ item, children, contextMenuContent, onClick }: CardShellProps) {
  const status = item.status ?? 'ready';
  const isFinal = item.type === 'final';
  const isReady = status === 'ready';
  const isError = status === 'error';
  const isGold = isFinal && (isReady || isRenderingState(status));

  const classes = cn(
    'relative group overflow-hidden bg-card/30 backdrop-blur-sm clip-corner-br',
    'aspect-video w-full shrink-0',
    // State classes (skip for final on non-rendering states)
    !isFinal && status !== 'ready' && status !== 'error' && stateClassMap[status],
    isRenderingState(status) && stateClassMap.rendering,
    // Ready state
    isReady && !isGold && 'clip-state-ready cursor-pointer hover:border hover:border-primary',
    isGold && 'cursor-pointer hover:border-amber-400',
    // Error state
    isError && 'border-2 border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.4)]',
    // Final golden styling
    isGold && !isError && 'clip-state-final !border-2 !border-amber-400/50',
    !isGold && !isError && !isReady && 'border-0',
  );

  const accentClasses = cn(
    'absolute bottom-0 inset-x-0 h-1 transition-opacity z-40',
    isError ? 'bg-red-500 opacity-100' : isGold ? 'bg-amber-400 opacity-100' : 'bg-primary opacity-0',
    !isGold && !isError && isReady && 'group-hover:opacity-100',
  );

  const card = (
    <div className={classes} onClick={onClick}>
      {/* Bottom border accent */}
      <div className={accentClasses} />

      {/* State overlay */}
      <StateOverlay item={item} />

      {/* CONTENT - Type-specific rendering */}
      {children}

      {/* Clipped corner border */}
      <svg
        className="absolute transition-opacity pointer-events-none z-40 opacity-100"
        width="14"
        height="14"
        viewBox="0 0 14 14"
        style={{ bottom: '-5px', right: '-2px' }}
      >
        <line
          x1="0"
          y1="14"
          x2="14"
          y2="0"
          stroke={getCornerStrokeColor(item.status, isFinal, isError, isReady)}
          strokeWidth={isGold || isError ? '2.5' : '2'}
        />
      </svg>
    </div>
  );

  if (!contextMenuContent) return card;

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>{contextMenuContent}</ContextMenuContent>
    </ContextMenu>
  );
}
