import type { CSSProperties, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import {
  ContextMenu,
  ContextMenuTrigger,
  ContextMenuContent,
} from '@/components/ui/context-menu';
import type { MediaItem, ClipState } from '../types';
import { getCardVisualState, isRenderingState } from '../stateColors';
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
  if (status === 'error') return <FailedOverlay item={item} />;
  if (status === 'loading') return <LoadingOverlay item={item} />;
  if (status === 'deleting') return <DeletingOverlay item={item} />;
  const pipelineLabel = PIPELINE_STATE_LABELS[status];
  if (pipelineLabel && type !== 'final') return <GeneratingOverlay item={item} label={pipelineLabel} />;

  return null;
}

export function CardShell({ item, children, contextMenuContent, selected, onClick, draggable, dragData, onMarkSeen }: CardShellProps) {
  const visual = getCardVisualState(item);
  const isUnseen = visual.isReady && !visual.isError && item.seenAt == null;
  const showAccent = visual.isError || visual.isGold || visual.isActive || selected;

  const classes = cn(
    'relative group overflow-hidden bg-card/30 backdrop-blur-sm clip-corner-br',
    'aspect-video w-full shrink-0 border transition-colors',
    visual.stateClass,
    visual.cursorClass,
    visual.isReady && !visual.isGold && !visual.isError && 'border-transparent hover:border-[var(--card-state-color)]',
    visual.isGold && 'border-2 border-[var(--card-state-border)] hover:border-[var(--card-state-color)]',
    visual.isError && 'border-2 border-[var(--card-state-border)] hover:border-[var(--card-state-color)] shadow-[0_0_15px_var(--card-state-glow)]',
    visual.isActive && !visual.isDeleting && 'border-[var(--card-state-border)]',
    visual.isDeleting && 'border-2 border-[var(--card-state-border)]',
    selected && 'border-2 border-[var(--card-state-color)] shadow-[0_0_12px_var(--card-state-glow)]',
  );

  const accentClasses = cn(
    'absolute bottom-0 inset-x-0 h-1 transition-opacity z-40',
    showAccent ? 'opacity-100' : 'opacity-0',
    !showAccent && visual.isReady && 'group-hover:opacity-100',
  );

  const cardStyle = {
    '--card-state-color': visual.color,
    '--card-state-rgb': visual.rgb,
    '--card-state-border': visual.border,
    '--card-state-glow': visual.glow,
    '--card-state-soft': visual.soft,
    '--card-state-faint': visual.faint,
  } as CSSProperties;

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
    <div className={classes} style={cardStyle} onClick={handleClick} draggable={draggable} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      {/* Bottom border accent */}
      <div className={accentClasses} style={{ backgroundColor: visual.color }} />

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
          stroke={visual.color}
          strokeWidth={visual.isGold || visual.isError || selected ? '2.5' : '2'}
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
