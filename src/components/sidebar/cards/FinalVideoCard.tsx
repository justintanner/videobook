import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import { SlugBadge } from './badges';

function isRenderingState(status: string): boolean {
  return status === 'rendering' ||
    status === 'rendering-landscape' ||
    status === 'rendering-portrait' ||
    status === 'render-queued' ||
    status === 'render-queued-landscape' ||
    status === 'render-queued-portrait' ||
    status === 'rendering-square' ||
    status === 'render-queued-square';
}

interface FinalVideoCardProps {
  item: MediaItem;
}

export function FinalVideoCard({ item }: FinalVideoCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const showElfOverlay = isRenderingState(status);
  const thumbSrc = item.thumbnailSrc || (item.filePath ? item.filePath.replace(/\/[^/]+$/, '/thumbnail.jpg') : null);

  return (
    <CardShell item={item}>
      {/* CONTENT - Thumbnail */}
      {thumbSrc && (
        <img
          src={thumbSrc}
          alt={item.title}
          draggable={false}
          className="w-full h-full object-cover transition-opacity"
          onError={(e) => {
            e.currentTarget.style.display = 'none';
          }}
        />
      )}

      {/* Slug badge - hidden during elf overlay states */}
      {!showElfOverlay && <SlugBadge slug={item.slug} colorScheme="gold" isError={isError} />}
    </CardShell>
  );
}
