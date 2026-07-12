import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import type { DragData } from './CardShell';
import { SlugBadge } from './badges';
import { ErrorCardActions } from './ErrorCardActions';

import type { ReactNode } from 'react';

interface CharacterCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onMarkSeen?: () => void;
  onRecover?: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
}

export function CharacterCard({ item, contextMenuContent, selected, onClick, onMarkSeen, onRecover, onDelete }: CharacterCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const isCorrupt = false;
  const isUploading = status === 'uploading';
  const isGenerating = status === 'generating';
  const isLoading = status === 'loading';
  const isDownloading = status === 'downloading';
  const hasOpaqueOverlay = isUploading || isGenerating || isLoading || isCorrupt;

  return (
    <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick} onMarkSeen={onMarkSeen} draggable dragData={{ slug: item.slug, id: item.id, filePath: item.filePath, thumbnailSrc: item.thumbnailSrc, type: item.type } as DragData}>
      {/* CONTENT - Image */}
      {item.thumbnailSrc ? (
        <img
          src={item.thumbnailSrc}
          alt={item.title}
          loading="lazy"
          draggable={false}
          className="w-full h-full object-cover transition-opacity"
        />
      ) : item.filePath ? (
        <img
          src={item.filePath}
          alt={item.title}
          loading="lazy"
          draggable={false}
          className="w-full h-full object-cover transition-opacity"
        />
      ) : (
        <div className="w-full h-full bg-muted flex items-center justify-center font-mono text-xs opacity-50">
          No image
        </div>
      )}

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge item={item} muted={hasOpaqueOverlay || isDownloading} />}

      {/* Recover / Delete buttons — visible on hover for error-state cards */}
      {isError && <ErrorCardActions item={item} onRecover={onRecover} onDelete={onDelete} />}
    </CardShell>
  );
}
