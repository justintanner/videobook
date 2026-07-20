import { useState, type DragEvent as ReactDragEvent } from 'react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import type { DragData } from './CardShell';
import { SlugBadge, DurationBadge, OsgBadge } from './badges';
import { ErrorCardActions } from './ErrorCardActions';

import type { ReactNode } from 'react';

interface FinalVideoCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onMarkSeen?: () => void;
  onRecover?: (item: MediaItem) => void;
  onDelete?: (item: MediaItem) => void;
  onImageDropped?: (imageAssetId: string, imageSlug: string) => void;
  onEditOsg?: () => void;
}

export function FinalVideoCard({ item, contextMenuContent, selected, onClick, onMarkSeen, onRecover, onDelete, onImageDropped, onEditOsg }: FinalVideoCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const thumbSrc = item.thumbnailSrc || (item.filePath ? item.filePath.replace(/\/[^/]+$/, '/original.jpg') : null);
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  const [dropActive, setDropActive] = useState(false);
  const showThumb = thumbSrc !== null && erroredSrc !== thumbSrc;
  const canAcceptDrop = !!onImageDropped && status === 'ready';
  const handleDragOver = canAcceptDrop
    ? (event: ReactDragEvent<HTMLDivElement>) => {
        if (!event.dataTransfer.types.includes('application/x-videocity-asset-image')) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        setDropActive(true);
      }
    : undefined;
  const handleDragLeave = canAcceptDrop
    ? (event: ReactDragEvent<HTMLDivElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false);
      }
    : undefined;
  const handleDrop = canAcceptDrop
    ? (event: ReactDragEvent<HTMLDivElement>) => {
        event.preventDefault();
        setDropActive(false);
        try {
          const data = JSON.parse(event.dataTransfer.getData('application/json')) as DragData;
          if (data.type === 'image' && data.id) onImageDropped(data.id, data.slug);
        } catch {
          return;
        }
      }
    : undefined;

  return (
    <div className="relative w-full" onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}>
      <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick} onMarkSeen={onMarkSeen} draggable dragData={{ slug: item.slug, id: item.id, filePath: item.filePath, thumbnailSrc: item.thumbnailSrc, type: item.type } as DragData}>
      {/* CONTENT - Thumbnail */}
      {showThumb && (
        <img
          src={thumbSrc}
          alt={item.title}
          loading="lazy"
          draggable={false}
 className="size-full object-cover transition-opacity"
          onError={() => setErroredSrc(thumbSrc)}
        />
      )}

      {/* Duration badge - top left */}
      <DurationBadge item={item} seconds={item.duration} muted={status !== 'ready'} />

      {!isError && item.osg && <OsgBadge osg={item.osg} onClick={onEditOsg} />}

      {/* Slug badge */}
      <SlugBadge item={item} muted={status !== 'ready'} />

      {/* Recover / Delete buttons — visible on hover for error-state cards */}
      {isError && <ErrorCardActions item={item} onRecover={onRecover} onDelete={onDelete} />}
      </CardShell>
      {dropActive && (
        <div className={cn('absolute inset-0 z-50 pointer-events-none flex items-center justify-center', 'bg-emerald-500/20 ring-2 ring-emerald-400 ring-inset')}>
          <span className="px-2 py-1 rounded-sm bg-black/85 backdrop-blur-md border border-emerald-400/60 text-[10px] font-mono font-bold tracking-widest text-emerald-300">
            SET OSG?
          </span>
        </div>
      )}
    </div>
  );
}
