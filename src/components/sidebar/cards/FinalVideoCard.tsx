import { useState } from 'react';
import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import type { DragData } from './CardShell';
import { SlugBadge } from './badges';
import { isRenderingState } from '../stateColors';

import type { ReactNode } from 'react';

interface FinalVideoCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onMarkSeen?: () => void;
}

export function FinalVideoCard({ item, contextMenuContent, selected, onClick, onMarkSeen }: FinalVideoCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const showElfOverlay = isRenderingState(status);
  const thumbSrc = item.thumbnailSrc || (item.filePath ? item.filePath.replace(/\/[^/]+$/, '/original.jpg') : null);
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  const showThumb = thumbSrc !== null && erroredSrc !== thumbSrc;

  return (
    <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick} onMarkSeen={onMarkSeen} draggable dragData={{ slug: item.slug, id: item.id, filePath: item.filePath, thumbnailSrc: item.thumbnailSrc, type: item.type } as DragData}>
      {/* CONTENT - Thumbnail */}
      {showThumb && (
        <img
          src={thumbSrc}
          alt={item.title}
          loading="lazy"
          draggable={false}
          className="w-full h-full object-cover transition-opacity"
          onError={() => setErroredSrc(thumbSrc)}
        />
      )}

      {/* Slug badge - hidden during elf overlay states */}
      {!showElfOverlay && <SlugBadge slug={item.slug} colorScheme="gold" isError={isError} />}
    </CardShell>
  );
}
