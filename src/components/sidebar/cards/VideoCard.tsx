import { useState, type MouseEvent as ReactMouseEvent, type DragEvent as ReactDragEvent } from 'react';
import { X } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import type { DragData } from './CardShell';
import { SlugBadge, DurationBadge } from './badges';

import type { ReactNode } from 'react';

interface VideoCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onMarkSeen?: () => void;
  onDelete?: (item: MediaItem) => void;
  /** Fires when an aud-* card is dropped onto this video. HomePage uses this
   *  to surface a "replace audio?" confirm before invoking replace_video_audio. */
  onAudioDropped?: (audioAssetId: string, audioSlug: string) => void;
}

export function VideoCard({ item, contextMenuContent, selected, onClick, onMarkSeen, onDelete, onAudioDropped }: VideoCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const isCorrupt = false;
  const isUploading = status === 'uploading';
  const isDownloading = status === 'downloading';
  const isGenerating = status === 'generating';
  const isLoading = status === 'loading';
  const isTranscribing = status === 'transcribing';
  const isUntranscribed = false;
  const isRendering = status.startsWith('render');
  const isProcessing = isTranscribing || isUntranscribed || isRendering;
  const hasOpaqueOverlay = isUploading || isDownloading || isGenerating || isLoading || isCorrupt;

  const thumbSrc = item.thumbnailSrc || (item.filePath ? item.filePath.replace(/\/[^/]+$/, '/original.jpg') : null);

  // Track which src value failed to load. Reset implicitly when thumbSrc
  // changes (e.g., upload completes and a real thumbnail_url replaces the
  // bare-fallback URL that 404'd) — without this, an imperative display:none
  // would persist across re-renders and leave the tile black forever.
  const [erroredSrc, setErroredSrc] = useState<string | null>(null);
  const showThumb = thumbSrc !== null && erroredSrc !== thumbSrc;

  const [audioDragOver, setAudioDragOver] = useState(false);
  const canAcceptAudioDrop = !!onAudioDropped && status === 'ready';

  const handleDragOver = canAcceptAudioDrop
    ? (e: ReactDragEvent<HTMLDivElement>) => {
        if (!e.dataTransfer.types.includes('application/x-clipfirst-asset-audio')) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!audioDragOver) setAudioDragOver(true);
      }
    : undefined;

  const handleDragLeave = canAcceptAudioDrop
    ? (e: ReactDragEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setAudioDragOver(false);
        }
      }
    : undefined;

  const handleDrop = canAcceptAudioDrop
    ? (e: ReactDragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setAudioDragOver(false);
        try {
          const data = JSON.parse(e.dataTransfer.getData('application/json')) as DragData;
          if (data.type === 'audio' && data.id && onAudioDropped) onAudioDropped(data.id, data.slug);
        } catch {
          // Invalid drop payload — silently ignore.
        }
      }
    : undefined;

  return (
    <div
      className="relative w-full"
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick} onMarkSeen={onMarkSeen} draggable dragData={{ slug: item.slug, id: item.id, filePath: item.filePath, thumbnailSrc: thumbSrc, type: item.type } as DragData}>
      {/* CONTENT - Thumbnail */}
      {showThumb && (
        <img
          src={thumbSrc}
          alt={item.title}
          loading="lazy"
          draggable={false}
          className={cn('w-full h-full object-cover transition-opacity', isProcessing && 'opacity-80')}
          onError={() => setErroredSrc(thumbSrc)}
        />
      )}

      {/* Duration badge - top left */}
      {!hasOpaqueOverlay && !isError && <DurationBadge item={item} seconds={item.duration} muted={isProcessing} />}

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge item={item} muted={hasOpaqueOverlay || isProcessing} />}

      {/* Delete button — visible on hover for error-state cards */}
      {isError && onDelete && (
        <button
          type="button"
          onClick={(e: ReactMouseEvent) => {
            e.stopPropagation();
            onDelete(item);
          }}
          aria-label={`Delete ${item.slug}`}
          className="absolute top-1 right-1 z-50 hidden group-hover:flex items-center justify-center w-5 h-5 rounded-sm bg-red-500/80 hover:bg-red-500 text-white transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      )}
      </CardShell>
      {audioDragOver && (
        <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center bg-amber-500/20 ring-2 ring-amber-400 ring-inset">
          <span className="px-2 py-1 rounded-sm bg-black/85 backdrop-blur-md border border-amber-400/60 text-[10px] font-mono font-bold tracking-widest text-amber-300">
            REPLACE AUDIO?
          </span>
        </div>
      )}
    </div>
  );
}
