import { cn } from '@/lib/utils';
import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import { SlugBadge, DurationBadge } from './badges';

function formatDuration(seconds: number | null | undefined): string | null {
  if (seconds == null || seconds <= 0) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

import type { ReactNode } from 'react';

interface VideoCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
}

export function VideoCard({ item, contextMenuContent, selected, onClick }: VideoCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const isCorrupt = status === 'corrupt';
  const isUploading = status === 'uploading';
  const isGenerating = status === 'generating';
  const isLoading = status === 'loading';
  const isTranscribing = status === 'transcribing';
  const isUntranscribed = status === 'untranscribed';
  const isRendering = status.startsWith('render');
  const isProcessing = isTranscribing || isUntranscribed || isRendering;
  const hasOpaqueOverlay = isUploading || isGenerating || isLoading || isCorrupt;

  const duration = formatDuration(item.durationSeconds);
  const thumbSrc = item.thumbnailSrc || (item.filePath ? item.filePath.replace(/\/[^/]+$/, '/thumbnail.jpg') : null);

  return (
    <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick}>
      {/* CONTENT - Thumbnail */}
      {thumbSrc && (
        <img
          src={thumbSrc}
          alt={item.title}
          loading="lazy"
          draggable={false}
          className={cn('w-full h-full object-cover transition-opacity', isProcessing && 'opacity-80')}
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      )}

      {/* Duration badge - top left */}
      {!hasOpaqueOverlay && !isError && duration && <DurationBadge duration={duration} isProcessing={isProcessing} />}

      {/* Slug badge */}
      {!hasOpaqueOverlay && (
        <SlugBadge slug={item.slug} colorScheme="cyan" isError={isError} isProcessing={isProcessing} />
      )}
    </CardShell>
  );
}
