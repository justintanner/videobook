import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import type { DragData } from './CardShell';
import { SlugBadge, ResolutionBadge } from './badges';
import { ErrorCardActions } from './ErrorCardActions';
import { cn } from '@/lib/utils';

import type { ReactNode } from 'react';

interface ImageCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onMarkSeen?: () => void;
  onRecover?: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
}

export function ImageCard({ item, contextMenuContent, selected, onClick, onMarkSeen, onRecover, onDelete }: ImageCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const isCorrupt = false;
  const isUploading = status === 'uploading';
  const isGenerating = status === 'generating';
  const isLoading = status === 'loading';
  const isDownloading = status === 'downloading';
  const hasOpaqueOverlay = isUploading || isGenerating || isLoading || isCorrupt;
  const isQart = item.origin === 'create_qart';

  return (
    <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick} onMarkSeen={onMarkSeen} draggable dragData={{ slug: item.slug, id: item.id, filePath: item.filePath, thumbnailSrc: item.thumbnailSrc, type: item.type } as DragData}>
      {/* CONTENT - Image */}
      {item.filePath && (
        <img
          src={item.filePath}
          alt={item.title}
          loading="lazy"
          draggable={false}
          className={cn(
            'size-full transition-opacity',
            isQart ? 'bg-white object-contain' : 'object-cover',
          )}
        />
      )}

      {/* Resolution Badge - Top Left */}
      {!hasOpaqueOverlay && !isError && item.width && item.height && (
        <ResolutionBadge item={item} width={item.width} height={item.height} />
      )}

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge item={item} muted={hasOpaqueOverlay || isDownloading} />}

      {/* Recover / Delete buttons — visible on hover for error-state cards */}
      {isError && <ErrorCardActions item={item} onRecover={onRecover} onDelete={onDelete} />}
    </CardShell>
  );
}
