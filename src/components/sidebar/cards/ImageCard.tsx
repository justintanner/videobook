import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import { SlugBadge, ResolutionBadge } from './badges';

interface ImageCardProps {
  item: MediaItem;
}

export function ImageCard({ item }: ImageCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const isCorrupt = status === 'corrupt';
  const isUploading = status === 'uploading';
  const isGenerating = status === 'generating';
  const isDownloading = status === 'downloading';
  const isLoading = status === 'loading';
  const hasOpaqueOverlay = isUploading || isGenerating || isDownloading || isLoading || isCorrupt;

  return (
    <CardShell item={item}>
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
