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

  return (
    <CardShell item={item}>
      {/* CONTENT - Image */}
      {item.filePath && (
        <img
          src={item.filePath}
          alt={item.title}
          draggable={false}
          className="w-full h-full object-cover transition-opacity"
        />
      )}

      {/* Resolution Badge - Top Left */}
      {!isUploading && !isError && !isCorrupt && item.width && item.height && (
        <ResolutionBadge width={item.width} height={item.height} />
      )}

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge slug={item.slug} colorScheme="cyan" isError={isError} />}
    </CardShell>
  );
}
