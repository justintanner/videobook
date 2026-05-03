import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
} from '@/components/ui/context-menu';
import type { MediaItem, ClipState } from '../types';
import { cornerStrokeColor, isRenderingState } from '../stateColors';
import { NewBadge } from './badges';
import {
  UploadingOverlay,
  GeneratingOverlay,
  RenderingOverlay,
  ElfBuildingOverlay,
  TranscribingOverlay,
  FailedOverlay,
  LoadingOverlay,
  DeletingOverlay,
  DownloadingOverlay,
} from '../overlays';

export interface DragData {
  slug: string;
  id: string;
  filePath: string;
  thumbnailSrc?: string;
  type: string;
}

export interface CardShellProps {
  item: MediaItem;
  children: ReactNode;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  draggable?: boolean;
  dragData?: DragData;
  /** Fired before `onClick` when the user clicks an unseen asset, and on a
   *  successful drag-drop (dropEffect !== 'none'). HomePage wires this to the
   *  optimistic local update + the `mark_asset_seen` MCP tool. */
  onMarkSeen?: () => void;
}

// Pipeline states that all reuse GeneratingOverlay with a custom label.
// First pass at distinct overlays — visual differentiation can iterate.
const PIPELINE_STATE_LABELS: Partial<Record<ClipState, string>> = {
  processing: 'PROCESSING',
  analyzing: 'ANALYZING',
  trimming: 'TRIMMING',
  splicing: 'SPLICING',
  reversing: 'REVERSING',
  'changing-speed': 'CHANGING SPEED',
  'replacing-audio': 'REPLACING AUDIO',
  isolating: 'ISOLATING VOCALS',
};

function StateOverlay({ item }: { item: MediaItem }) {
  const status = item.status;
  const type = item.type;
  if (!status) return null;

  if (status === 'uploading' && type !== 'final') return <UploadingOverlay item={item} />;
  if (status === 'downloading' && type !== 'final') return <DownloadingOverlay item={item} />;
  if (status === 'generating' && type !== 'final') return <GeneratingOverlay item={item} />;
  if (isRenderingState(status)) return type === 'final' ? <ElfBuildingOverlay item={item} /> : <RenderingOverlay item={item} />;
  if (status === 'transcribing' && (type === 'video' || type === 'audio')) return <TranscribingOverlay item={item} />;
  if (status === 'error' && type !== 'script') return <FailedOverlay item={item} />;
  if (status === 'loading') return <LoadingOverlay item={item} />;
  if (status === 'deleting') return <DeletingOverlay item={item} />;
  const pipelineLabel = PIPELINE_STATE_LABELS[status];
  if (pipelineLabel && type !== 'final') return <GeneratingOverlay item={item} label={pipelineLabel} />;

  return null;
}

const stateClassMap: Partial<Record<ClipState, string>> = {
  uploading: 'clip-state-uploading cursor-wait',
  downloading: 'clip-state-downloading cursor-wait',
  generating: 'clip-state-generating cursor-wait',  // video default; overridden for images below
  // Pipeline / transformation states reuse the generating animation so the
  // sidebar shows a consistent "in progress" look across the lifecycle.
  processing: 'clip-state-generating cursor-wait',
  analyzing: 'clip-state-generating cursor-wait',
  trimming: 'clip-state-generating cursor-wait',
  splicing: 'clip-state-generating cursor-wait',
  reversing: 'clip-state-generating cursor-wait',
  'changing-speed': 'clip-state-generating cursor-wait',
  'replacing-audio': 'clip-state-generating cursor-wait',
  isolating: 'clip-state-generating cursor-wait',
  rendering: 'clip-state-rendering cursor-wait',
  'rendering-landscape': 'clip-state-rendering cursor-wait',
  'rendering-portrait': 'clip-state-rendering cursor-wait',
  'render-queued': 'clip-state-rendering cursor-wait',
  'render-queued-landscape': 'clip-state-rendering cursor-wait',
  'render-queued-portrait': 'clip-state-rendering cursor-wait',
  'rendering-square': 'clip-state-rendering cursor-wait',
  'render-queued-square': 'clip-state-rendering cursor-wait',
  transcribing: 'clip-state-transcribing cursor-pointer',
  loading: 'clip-state-loading cursor-wait',
  deleting: 'clip-state-deleting pointer-events-none cursor-default',
};

export function CardShell({ item, children, contextMenuContent, selected, onClick, draggable, dragData, onMarkSeen }: CardShellProps) {
  const status = item.status ?? 'ready';
  const isFinal = item.type === 'final';
  const isReady = status === 'ready';
  const isError = status === 'error' && item.type !== 'script';
  const isGold = isFinal && (isReady || isRenderingState(status));
  const isUnseen = isReady && !isError && item.seenAt == null;

  const generatingClass = status === 'generating' && (item.type === 'image' || item.type === 'character')
    ? 'clip-state-generating-image cursor-wait'
    : stateClassMap[status];

  const classes = cn(
    'relative group overflow-hidden bg-card/30 backdrop-blur-sm clip-corner-br',
    'aspect-video w-full shrink-0',
    // State classes (skip for final on non-rendering states)
    !isFinal && status !== 'ready' && status !== 'error' && generatingClass,
    isRenderingState(status) && stateClassMap.rendering,
    // Ready state
    isReady && !isGold && 'clip-state-ready cursor-pointer hover:border hover:border-primary',
    isGold && 'cursor-pointer hover:border-amber-400',
    // Error state
    isError && 'border-2 border-red-500/50 shadow-[0_0_15px_rgba(239,68,68,0.4)]',
    // Final golden styling
    isGold && !isError && 'clip-state-final !border-2 !border-amber-400/50',
    !isGold && !isError && !isReady && 'border-0',
    // Selected state
    selected && !isError && 'border-2 border-primary shadow-[0_0_12px_rgba(0,255,255,0.3)]',
  );

  const accentClasses = cn(
    'absolute bottom-0 inset-x-0 h-1 transition-opacity z-40',
    isError ? 'bg-red-500 opacity-100' : isGold ? 'bg-amber-400 opacity-100' : selected ? 'bg-primary opacity-100' : 'bg-primary opacity-0',
    !isGold && !isError && !selected && isReady && 'group-hover:opacity-100',
  );

  const handleDragStart = draggable && dragData
    ? (e: React.DragEvent) => {
        e.dataTransfer.setData('application/json', JSON.stringify(dragData));
        e.dataTransfer.effectAllowed = 'copy';
      }
    : undefined;

  const handleDragEnd = draggable && onMarkSeen && isUnseen
    ? (e: React.DragEvent) => {
        if (e.dataTransfer.dropEffect !== 'none') onMarkSeen();
      }
    : undefined;

  const handleClick = onClick || onMarkSeen
    ? () => {
        if (isUnseen) onMarkSeen?.();
        onClick?.();
      }
    : undefined;

  const card = (
    <div className={classes} onClick={handleClick} draggable={draggable} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      {/* Bottom border accent */}
      <div className={accentClasses} />

      {/* State overlay */}
      <StateOverlay item={item} />

      {/* NEW badge (top-right) - only when ready, not errored, never seen */}
      {isUnseen && <NewBadge />}

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
          stroke={cornerStrokeColor({ status: item.status, isFinal, isError, isReady, itemType: item.type })}
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
