import { useState, useEffect, useCallback, useRef } from 'react';
import { X, Check, Loader2, CheckCircle2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';

interface InboxDrawerProps {
  open: boolean;
  onClose: () => void;
  videos: MediaItem[];
  pendingVideos: MediaItem[];
  onApprove: (video: MediaItem) => void;
  onReject: (video: MediaItem) => void;
}

export function InboxDrawer({
  open,
  onClose,
  videos,
  pendingVideos,
  onApprove,
  onReject,
}: InboxDrawerProps) {
  const [mutatingIds, setMutatingIds] = useState<Set<string>>(new Set());
  const [allClear, setAllClear] = useState(false);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  const hasPending = pendingVideos.length > 0;

  // Two-phase open: mount then animate in
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => {
        setMutatingIds(new Set());
        setAllClear(false);
        setActiveVideoId(null);
        setVisible(true);
      }, 0);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => setVisible(false), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Initialize active video to first, and recover if active video is removed
  useEffect(() => {
    if (!open || videos.length === 0) return;
    if (activeVideoId === null || !videos.some((v) => v.id === activeVideoId)) {
      const t = setTimeout(() => setActiveVideoId(videos[0].id), 0);
      return () => clearTimeout(t);
    }
  }, [open, videos, activeVideoId]);

  // All-clear detection: both arrays empty + no in-flight mutations
  useEffect(() => {
    if (open && videos.length === 0 && pendingVideos.length === 0 && mutatingIds.size === 0) {
      const t = setTimeout(() => setAllClear(true), 0);
      return () => clearTimeout(t);
    }
  }, [open, videos.length, pendingVideos.length, mutatingIds.size]);

  // Auto-close after all clear
  useEffect(() => {
    if (!allClear) return;
    const timer = setTimeout(onClose, 1500);
    return () => clearTimeout(timer);
  }, [allClear, onClose]);

  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const handleVideoEnded = useCallback(
    (videoId: string) => {
      const idx = videos.findIndex((v) => v.id === videoId);
      if (idx === -1 || videos.length <= 1) return;
      const nextIdx = (idx + 1) % videos.length;
      setActiveVideoId(videos[nextIdx].id);
    },
    [videos]
  );

  const advanceActiveIfNeeded = useCallback(
    (removedId: string) => {
      if (activeVideoId !== removedId) return;
      const remaining = videos.filter((v) => v.id !== removedId);
      if (remaining.length === 0) {
        setActiveVideoId(null);
        return;
      }
      const oldIdx = videos.findIndex((v) => v.id === removedId);
      const nextIdx = Math.min(oldIdx, remaining.length - 1);
      setActiveVideoId(remaining[nextIdx].id);
    },
    [activeVideoId, videos]
  );

  const handleApprove = useCallback(
    (video: MediaItem) => {
      if (mutatingIds.has(video.id)) return;
      advanceActiveIfNeeded(video.id);
      setMutatingIds((prev) => new Set(prev).add(video.id));
      onApprove(video);
      setTimeout(() => {
        setMutatingIds((prev) => {
          const next = new Set(prev);
          next.delete(video.id);
          return next;
        });
      }, 600);
    },
    [mutatingIds, advanceActiveIfNeeded, onApprove]
  );

  const handleReject = useCallback(
    (video: MediaItem) => {
      if (mutatingIds.has(video.id)) return;
      advanceActiveIfNeeded(video.id);
      setMutatingIds((prev) => new Set(prev).add(video.id));
      onReject(video);
      setTimeout(() => {
        setMutatingIds((prev) => {
          const next = new Set(prev);
          next.delete(video.id);
          return next;
        });
      }, 600);
    },
    [mutatingIds, advanceActiveIfNeeded, onReject]
  );

  const activeIndex = videos.findIndex((v) => v.id === activeVideoId);

  if (!open) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        className={cn(
          'fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0'
        )}
        onClick={onClose}
      />

      {/* Full-screen container */}
      <div
        role="dialog"
        aria-label="Review pending generations"
        className={cn(
          'fixed inset-0 z-[101] bg-zinc-950 flex flex-col transition-all duration-300',
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        )}
      >
        {allClear ? (
          <div className="flex-1 flex items-center justify-center animate-in fade-in duration-300">
            <AllClearState />
          </div>
        ) : (
          <>
            <ReviewHeader activeIndex={activeIndex} videoCount={videos.length} onClose={onClose} />

            {/* Scrollable grid */}
            <div className="flex-1 overflow-y-auto p-6">
              {videos.length > 0 ? (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(300px,1fr))] gap-4">
                  {videos.map((video) => (
                    <ReviewTile
                      key={video.id}
                      video={video}
                      isActive={video.id === activeVideoId}
                      isMutating={mutatingIds.has(video.id)}
                      onApprove={handleApprove}
                      onReject={handleReject}
                      onVideoEnded={handleVideoEnded}
                      onActivate={setActiveVideoId}
                    />
                  ))}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full text-muted-foreground text-sm font-mono">
                  Waiting for generations to complete...
                </div>
              )}
            </div>

            {hasPending && <PendingSection videos={pendingVideos} />}
          </>
        )}
      </div>
    </>
  );
}

function AllClearState() {
  return (
    <div className="flex flex-col items-center justify-center py-12 px-6">
      <CheckCircle2 className="w-12 h-12 text-primary mb-3" />
      <span className="text-sm font-mono font-bold tracking-widest text-primary uppercase">ALL_CLEAR</span>
    </div>
  );
}

function ReviewHeader({
  activeIndex,
  videoCount,
  onClose,
}: {
  activeIndex: number;
  videoCount: number;
  onClose: () => void;
}) {
  return (
    <div className="flex items-center justify-between px-6 py-4 border-b border-border/50 shrink-0">
      <span className="text-xs font-mono font-bold tracking-widest text-primary/70 uppercase">REVIEW_QUEUE</span>
      <div className="flex items-center gap-3">
        {videoCount > 0 && (
          <span className="text-xs font-mono text-muted-foreground">
            {activeIndex >= 0
              ? `${activeIndex + 1}/${videoCount}`
              : `${videoCount} ${videoCount === 1 ? 'VIDEO' : 'VIDEOS'}`}
          </span>
        )}
        <button
          onClick={onClose}
          aria-label="Close review queue"
          className="text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
    </div>
  );
}

interface ReviewTileProps {
  video: MediaItem;
  isActive: boolean;
  isMutating: boolean;
  onApprove: (video: MediaItem) => void;
  onReject: (video: MediaItem) => void;
  onVideoEnded: (videoId: string) => void;
  onActivate: (videoId: string) => void;
}

function ReviewTile({ video, isActive, isMutating, onApprove, onReject, onVideoEnded, onActivate }: ReviewTileProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const tileRef = useRef<HTMLDivElement>(null);

  // Imperative play/pause based on active state
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    if (isActive) {
      el.currentTime = 0;
      el.play().catch(() => {});
    } else {
      el.pause();
    }
  }, [isActive]);

  // Auto-scroll active tile into view
  useEffect(() => {
    if (isActive && tileRef.current) {
      tileRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [isActive]);

  const durationLabel = video.durationSeconds
    ? `${Math.floor(video.durationSeconds / 60)}:${String(video.durationSeconds % 60).padStart(2, '0')}`
    : null;

  return (
    <div
      ref={tileRef}
      className={cn(
        'rounded-lg overflow-hidden flex flex-col transition-all duration-300',
        isActive
          ? 'border border-primary/60 bg-card/95 shadow-[0_0_15px_rgba(0,255,255,0.15)]'
          : 'border border-border/20 bg-card/60 opacity-60'
      )}
    >
      {/* Video area — click inactive tiles to activate */}
      <div
        className={cn('aspect-video bg-black relative', !isActive && 'cursor-pointer')}
        onClick={isActive ? undefined : () => onActivate(video.id)}
      >
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
      </div>

      {/* Action buttons */}
      <div className="flex border-t border-border/50">
        <button
          onClick={() => onReject(video)}
          disabled={isMutating}
          aria-label={`Reject ${video.slug}`}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-red-400 hover:bg-red-500/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed border-r border-border/50"
        >
          {isMutating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <X className="w-3.5 h-3.5" />}
          REJECT
        </button>
        <button
          onClick={() => onApprove(video)}
          disabled={isMutating}
          aria-label={`Approve ${video.slug}`}
          className="flex-1 flex items-center justify-center gap-1.5 py-2.5 text-xs font-mono font-bold tracking-wider text-primary hover:bg-primary/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {isMutating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Check className="w-3.5 h-3.5" />}
          APPROVE
        </button>
      </div>
    </div>
  );
}

function PendingSection({ videos }: { videos: MediaItem[] }) {
  const statusTag = (status: string | undefined) => {
    if (status === 'generating') return 'GEN';
    if (status === 'downloading') return 'DL';
    return status?.toUpperCase() ?? '...';
  };

  return (
    <div className="border-t border-border/50 shrink-0">
      <div className="flex items-center gap-2 px-6 py-2">
        <span className="text-[10px] font-mono font-bold tracking-widest text-amber-500/70 uppercase">INCOMING</span>
        <span className="text-[10px] font-mono text-muted-foreground">{videos.length}</span>
      </div>
      <div className="max-h-32 overflow-y-auto px-6 pb-3 flex flex-wrap gap-x-4 gap-y-1.5">
        {videos.map((video) => (
          <div key={video.id} className="flex items-center gap-2 text-xs font-mono text-muted-foreground">
            <Loader2 className="w-3 h-3 animate-spin text-amber-500/60 shrink-0" />
            <span className="truncate text-foreground/70">{video.slug}</span>
            <span className="text-[10px] bg-amber-500/15 text-amber-500/70 px-1.5 rounded shrink-0">
              {statusTag(video.status)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}
