import { useState, type DragEvent as ReactDragEvent } from 'react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import type { DragData } from './CardShell';
import { SlugBadge, DurationBadge, OsgBadge } from './badges';
import { ErrorCardActions } from './ErrorCardActions';

import type { ReactNode } from 'react';

interface VideoCardProps {
  item: MediaItem;
  contextMenuContent?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  onMarkSeen?: () => void;
  onDelete?: (item: MediaItem) => void;
  /** Fires when the user recovers a failed card. HomePage clears the asset's
   *  persisted error (recover_asset) and re-syncs, returning it to ready. */
  onRecover?: (item: MediaItem) => void;
  /** Fires when the user clicks the always-visible Retry pill on a failed
   *  card. HomePage replays the generation (retry_generation) and re-syncs. */
  onRetry?: (item: MediaItem) => void;
  /** Fires when an aud-* card is dropped onto this video. HomePage uses this
   *  to surface a "replace audio?" confirm before invoking replace_video_audio. */
  onAudioDropped?: (audioAssetId: string, audioSlug: string) => void;
  /** Fires when an img-* card is dropped onto this video — sets it as the OSG
   *  overlay and opens the positioning overlay. */
  onImageDropped?: (imageAssetId: string, imageSlug: string) => void;
  /** Fires when the OSG badge is clicked — opens the positioning overlay. */
  onEditOsg?: () => void;
}

export function VideoCard({ item, contextMenuContent, selected, onClick, onMarkSeen, onDelete, onRecover, onRetry, onAudioDropped, onImageDropped, onEditOsg }: VideoCardProps) {
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

  // The video card accepts two kinds of asset drop: an audio clip (replace the
  // video's audio) and an image (set it as the OSG overlay). We track which kind
  // is hovering so the affordance label matches.
  const [dropKind, setDropKind] = useState<'audio' | 'image' | null>(null);
  const canAcceptAudioDrop = !!onAudioDropped && status === 'ready';
  const canAcceptImageDrop = !!onImageDropped && status === 'ready';
  const canAcceptDrop = canAcceptAudioDrop || canAcceptImageDrop;

  const handleDragOver = canAcceptDrop
    ? (e: ReactDragEvent<HTMLDivElement>) => {
        const isAudio = canAcceptAudioDrop && e.dataTransfer.types.includes('application/x-videocity-asset-audio');
        const isImage = canAcceptImageDrop && e.dataTransfer.types.includes('application/x-videocity-asset-image');
        if (!isAudio && !isImage) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        const kind = isAudio ? 'audio' : 'image';
        if (dropKind !== kind) setDropKind(kind);
      }
    : undefined;

  const handleDragLeave = canAcceptDrop
    ? (e: ReactDragEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setDropKind(null);
        }
      }
    : undefined;

  const handleDrop = canAcceptDrop
    ? (e: ReactDragEvent<HTMLDivElement>) => {
        e.preventDefault();
        setDropKind(null);
        try {
          const data = JSON.parse(e.dataTransfer.getData('application/json')) as DragData;
          if (data.type === 'audio' && data.id && onAudioDropped) onAudioDropped(data.id, data.slug);
          else if (data.type === 'image' && data.id && onImageDropped) onImageDropped(data.id, data.slug);
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
      <CardShell item={item} contextMenuContent={contextMenuContent} selected={selected} onClick={onClick} onMarkSeen={onMarkSeen} onRetry={onRetry} draggable dragData={{ slug: item.slug, id: item.id, filePath: item.filePath, thumbnailSrc: thumbSrc, type: item.type } as DragData}>
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

      {/* OSG overlay badge — top/bottom corner per stored position */}
      {!hasOpaqueOverlay && !isError && item.osg && <OsgBadge osg={item.osg} onClick={onEditOsg} />}

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge item={item} muted={hasOpaqueOverlay || isProcessing} />}

      {/* Recover / Delete buttons — visible on hover for error-state cards */}
      {isError && <ErrorCardActions item={item} onRecover={onRecover} onDelete={onDelete} />}
      </CardShell>
      {dropKind === 'audio' && (
        <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center bg-amber-500/20 ring-2 ring-amber-400 ring-inset">
          <span className="px-2 py-1 rounded-sm bg-black/85 backdrop-blur-md border border-amber-400/60 text-[10px] font-mono font-bold tracking-widest text-amber-300">
            REPLACE AUDIO?
          </span>
        </div>
      )}
      {dropKind === 'image' && (
        <div className="absolute inset-0 z-50 pointer-events-none flex items-center justify-center bg-emerald-500/20 ring-2 ring-emerald-400 ring-inset">
          <span className="px-2 py-1 rounded-sm bg-black/85 backdrop-blur-md border border-emerald-400/60 text-[10px] font-mono font-bold tracking-widest text-emerald-300">
            SET OSG?
          </span>
        </div>
      )}
    </div>
  );
}
