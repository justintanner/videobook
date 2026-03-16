import { useEffect, useRef } from 'react';
import { X, Check } from 'lucide-react';
import { cn } from '@/lib/utils';
import { getCardOrientation, getCardWidthClass, getRatioLabel, getRatioBadgeClasses } from './inbox-utils';
import type { MediaItem } from '@/components/sidebar/types';

interface InboxReviewCardProps {
  video: MediaItem;
  cardNumber: number;
  isActive: boolean;
  isExiting: boolean;
  onApprove: (video: MediaItem) => void;
  onReject: (video: MediaItem) => void;
  onVideoEnded: (videoId: string) => void;
  onActivate: (videoId: string) => void;
  onExitComplete: (videoId: string) => void;
}

export function InboxReviewCard({
  video,
  cardNumber,
  isActive,
  isExiting,
  onApprove,
  onReject,
  onVideoEnded,
  onActivate,
  onExitComplete,
}: InboxReviewCardProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);

  const orientation = getCardOrientation(video.width, video.height);
  const widthClass = getCardWidthClass(orientation);
  const w = video.width ?? 1920;
  const h = video.height ?? 1080;

  // Imperative play/pause based on active state
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (isActive && !isExiting) {
      el.currentTime = 0;
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [isActive, isExiting]);

  // Auto-scroll active tile into view
  useEffect(() => {
    if (isActive && !isExiting && tileRef.current) {
      tileRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isActive, isExiting]);

  const durationLabel = video.durationSeconds
    ? `${Math.floor(video.durationSeconds / 60)}:${String(video.durationSeconds % 60).padStart(2, '0')}`
    : null;

  return (
    <div
      ref={tileRef}
      className={cn(
        widthClass,
        'rounded-lg overflow-hidden flex flex-col transition-all duration-300 shrink-0',
        isExiting && 'opacity-0 scale-90 pointer-events-none',
        !isExiting && isActive && 'border border-primary/60 bg-card/95 shadow-[0_0_15px_rgba(0,255,255,0.15)]',
        !isExiting && !isActive && 'border border-border/20 bg-card/60 opacity-60'
      )}
      onTransitionEnd={(e) => {
        if (isExiting && e.propertyName === 'opacity') {
          onExitComplete(video.id);
        }
      }}
    >
      {/* Video area */}
      <div
        className={cn('bg-black relative', !isActive && !isExiting && 'cursor-pointer')}
        style={{ aspectRatio: `${w}/${h}` }}
        onClick={isActive || isExiting ? undefined : () => onActivate(video.id)}
      >
        {/* Number badge */}
        <span className="absolute top-2 left-2 bg-black/70 text-primary text-xs font-mono font-bold px-1.5 py-0.5 rounded z-10">
          {cardNumber}
        </span>
        {video.filePath ? (
          <video
            ref={videoRef}
            src={video.filePath}
            loop={false}
            muted
            playsInline
            onEnded={() => onVideoEnded(video.id)}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center">
            <span className="text-xs font-mono text-muted-foreground/40">NO_SOURCE</span>
          </div>
        )}
      </div>

      {/* Metadata strip */}
      <div className="flex items-center gap-2 px-3 py-2 text-xs font-mono text-muted-foreground mt-auto">
        <span className="text-primary/70 truncate">{video.slug}</span>
        {durationLabel && (
          <>
            <span className="text-border">&middot;</span>
            <span className="shrink-0">{durationLabel}</span>
          </>
        )}
        {video.origin && (
          <>
            <span className="text-border">&middot;</span>
            <span className="shrink-0">{video.origin}</span>
          </>
        )}
        <span className="text-border">&middot;</span>
        <span className={cn('shrink-0 text-[10px] px-1 rounded', getRatioBadgeClasses(orientation))}>
          {getRatioLabel(orientation)}
        </span>
      </div>

      {/* Action buttons */}
      <div className="flex border-t border-border/50">
        <button
          onClick={() => onReject(video)}
          disabled={isExiting}
          aria-label={`Reject ${video.slug}`}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed border-r border-border/50"
        >
          <X className="w-3.5 h-3.5" />
          /reject
        </button>
        <button
          onClick={() => onApprove(video)}
          disabled={isExiting}
          aria-label={`Approve ${video.slug}`}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-primary hover:bg-primary/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <Check className="w-3.5 h-3.5" />
          /accept
        </button>
      </div>
    </div>
  );
}
