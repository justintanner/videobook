import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import { SlugBadge, ResolutionBadge } from './badges';

import type { ReactNode } from 'react';

interface ImageCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
}

export function ImageCard({ item, contextMenuContent, selected, onClick }: ImageCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const isCorrupt = status === 'corrupt';
  const isUploading = status === 'uploading';
  const isGenerating = status === 'generating';
  const isLoading = status === 'loading';
  const hasOpaqueOverlay = isUploading || isGenerating || isLoading || isCorrupt;

  return (
    <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick}>
      {/* CONTENT - Image */}
      {item.filePath && (
        <img
          src={item.filePath}
          alt={item.title}
          loading="lazy"
          draggable={false}
          className="w-full h-full object-cover transition-opacity"
        />
      )}

      {/* Resolution Badge - Top Left */}
      {!hasOpaqueOverlay && !isError && item.width && item.height && (
        <ResolutionBadge width={item.width} height={item.height} />
      )}

      {/* Slug badge */}
      {!hasOpaqueOverlay && <SlugBadge slug={item.slug} colorScheme="cyan" isError={isError} />}
    </CardShell>
  );
}
