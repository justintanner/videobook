import { AudioLines } from 'lucide-react';
import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import type { DragData } from './CardShell';
import { DurationBadge, SlugBadge } from './badges';
import { ErrorCardActions } from './ErrorCardActions';

import type { ReactNode } from 'react';

interface AudioCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onMarkSeen?: () => void;
  onRecover?: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
}

export function AudioCard({ item, contextMenuContent, selected, onClick, onMarkSeen, onRecover, onDelete }: AudioCardProps) {
  const isCorrupt = false;
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const isProcessing = status !== 'ready' && status !== 'error';

  return (
    <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick} onMarkSeen={onMarkSeen} draggable dragData={{ slug: item.slug, id: item.id, filePath: item.filePath, thumbnailSrc: item.thumbnailSrc, type: item.type } as DragData}>
      {/* CONTENT - Audio icon */}
      <div className="w-full h-full relative overflow-hidden">
        {/* Dark gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-black/40" />
        {/* Scanlines overlay */}
        <div className="absolute inset-0 scanlines pointer-events-none" />
        {/* Vignette effect */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.6)_100%)]" />
        {/* Centered audio icon */}
        <div className="absolute inset-0 flex items-center justify-center">
          <AudioLines className="w-10 h-10 text-primary/30" />
        </div>
      </div>

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge item={item} />}

      {!isCorrupt && !isError && (
        <DurationBadge item={item} seconds={item.duration} muted={isProcessing} />
      )}

      {/* Recover / Delete buttons — visible on hover for error-state cards */}
      {isError && <ErrorCardActions item={item} onRecover={onRecover} onDelete={onDelete} />}
    </CardShell>
  );
}
