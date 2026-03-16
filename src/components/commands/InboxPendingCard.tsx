import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getCardOrientation, getCardWidthClass, getRatioLabel, getRatioBadgeClasses, getStatusTag } from './inbox-utils';
import type { MediaItem } from '@/components/sidebar/types';

interface InboxPendingCardProps {
  video: MediaItem;
}

export function InboxPendingCard({ video }: InboxPendingCardProps) {
  const orientation = getCardOrientation(video.width, video.height);
  const widthClass = getCardWidthClass(orientation);
  const w = video.width ?? 1920;
  const h = video.height ?? 1080;

  return (
    <div
      className={cn(
        widthClass,
        'rounded-lg overflow-hidden flex flex-col shrink-0',
        'border border-amber-500/30 bg-card/60 animate-pulse'
      )}
    >
      {/* Thumbnail / placeholder */}
      <div className="bg-black relative" style={{ aspectRatio: `${w}/${h}` }}>
        {video.thumbnailSrc ? (
          <img src={video.thumbnailSrc} alt="" className="w-full h-full object-cover opacity-60" />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xs font-mono text-muted-foreground/30">{video.slug}</span>
          </div>
        )}
        {/* Progress overlay */}
        <div className="absolute inset-0 flex items-center justify-center bg-black/40">
          <div className="flex items-center gap-2">
            <Loader2 className="w-5 h-5 animate-spin text-amber-500/80" />
            <span className="text-[10px] font-mono font-bold bg-amber-500/15 text-amber-500/70 px-1.5 rounded">
              {getStatusTag(video.status)}
            </span>
          </div>
        </div>
      </div>

      {/* Metadata strip */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-muted-foreground mt-auto">
        <span className="text-amber-400/70 truncate">{video.slug}</span>
        {video.prompt && (
          <>
            <span className="text-border">&middot;</span>
            <span className="truncate text-muted-foreground/60">{video.prompt}</span>
          </>
        )}
        <span className="text-border">&middot;</span>
        <span className={cn('shrink-0 text-[10px] px-1 rounded', getRatioBadgeClasses(orientation))}>
          {getRatioLabel(orientation)}
        </span>
      </div>
    </div>
  );
}
