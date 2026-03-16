import { useState, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { InboxHeader } from './InboxHeader';
import { InboxAllClear } from './InboxAllClear';
import { InboxReviewCard } from './InboxReviewCard';
import { InboxPendingCard } from './InboxPendingCard';
import { ChatInput } from '@/components/ui/ChatInput';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import type { CommandDescriptor } from '@/lib/command-registry';
import type { MediaItem } from '@/components/sidebar/types';
import type { UseMcpResult } from 'use-mcp/react';

const INBOX_COMMANDS: CommandDescriptor[] = [
  {
    command: '/accept', description: 'Approve card by number', example: '/accept 2',
    category: 'action', icon: 'Check', size: 'sm', variant: 'default', chevron: 'right',
    params: [{ name: 'number', type: 'number', required: false, description: 'Card number' }],
  },
  {
    command: '/reject', description: 'Reject card by number', example: '/reject 3',
    category: 'action', icon: 'X', size: 'sm', variant: 'default', chevron: 'right',
    params: [{ name: 'number', type: 'number', required: false, description: 'Card number' }],
  },
  {
    command: '/close', description: 'Close inbox', example: '/close',
    category: 'action', icon: 'X', size: 'sm', variant: 'default', chevron: 'right',
    params: [],
  },
];

interface InboxDrawerProps {
  open: boolean;
  onClose: () => void;
  videos: MediaItem[];
  pendingVideos: MediaItem[];
  onApprove: (video: MediaItem) => void;
  onReject: (video: MediaItem) => void;
  assetSlugs: string[];
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
}

export function InboxDrawer({
  open,
  onClose,
  videos,
  pendingVideos,
  onApprove,
  onReject,
  assetSlugs,
  callTool,
  projectSlug,
}: InboxDrawerProps) {
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const [removedIds, setRemovedIds] = useState<Set<string>>(new Set());
  const [allClear, setAllClear] = useState(false);
  const [activeVideoId, setActiveVideoId] = useState<string | null>(null);
  const [visible, setVisible] = useState(false);

  // Still rendered (includes exiting cards for animation)
  const renderedVideos = videos.filter((v) => !removedIds.has(v.id));
  // Logically present (excludes exiting cards for counter/active selection)
  const liveVideos = renderedVideos.filter((v) => !exitingIds.has(v.id));

  // Two-phase open: mount then animate in
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => {
        setExitingIds(new Set());
        setRemovedIds(new Set());
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
    if (!open || liveVideos.length === 0) return;
    if (activeVideoId === null || !liveVideos.some((v) => v.id === activeVideoId)) {
      const t = setTimeout(() => setActiveVideoId(liveVideos[0].id), 0);
      return () => clearTimeout(t);
    }
  }, [open, liveVideos, activeVideoId]);

  // All-clear detection: all videos gone + no pending
  useEffect(() => {
    if (open && liveVideos.length === 0 && pendingVideos.length === 0) {
      const t = setTimeout(() => setAllClear(true), 0);
      return () => clearTimeout(t);
    }
  }, [open, liveVideos.length, pendingVideos.length]);

  // Escape key handler — respect ChatInput's preventDefault
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  const handleVideoEnded = (videoId: string) => {
    const idx = liveVideos.findIndex((v) => v.id === videoId);
    if (idx === -1 || liveVideos.length <= 1) return;
    const nextIdx = (idx + 1) % liveVideos.length;
    setActiveVideoId(liveVideos[nextIdx].id);
  };

  const advanceActiveIfNeeded = (removedId: string) => {
    if (activeVideoId !== removedId) return;
    const remaining = liveVideos.filter((v) => v.id !== removedId);
    if (remaining.length === 0) {
      setActiveVideoId(null);
      return;
    }
    const oldIdx = liveVideos.findIndex((v) => v.id === removedId);
    const nextIdx = Math.min(oldIdx, remaining.length - 1);
    setActiveVideoId(remaining[nextIdx].id);
  };

  const handleExitComplete = (videoId: string) => {
    setExitingIds((prev) => { const next = new Set(prev); next.delete(videoId); return next; });
    setRemovedIds((prev) => new Set(prev).add(videoId));
  };

  const handleMutate = (video: MediaItem, action: (v: MediaItem) => void) => {
    if (exitingIds.has(video.id) || removedIds.has(video.id)) return;
    advanceActiveIfNeeded(video.id);
    setExitingIds((prev) => new Set(prev).add(video.id));
    action(video);
  };

  const handleApprove = (video: MediaItem) => handleMutate(video, onApprove);
  const handleReject = (video: MediaItem) => handleMutate(video, onReject);

  const { dispatch: contextDispatch, commands: contextCommands } = useCommandDispatch();
  const mergedCommands = [...INBOX_COMMANDS, ...contextCommands];

  const resolveTarget = (numStr: string | undefined): MediaItem | null => {
    if (numStr) {
      const n = parseInt(numStr, 10);
      if (n >= 1 && n <= liveVideos.length) return liveVideos[n - 1];
      return null;
    }
    if (activeVideoId) {
      const v = liveVideos.find((v) => v.id === activeVideoId);
      return v ?? null;
    }
    return null;
  };

  const handleInboxSend = async (message: string): Promise<boolean> => {
    const trimmed = message.trim();
    const acceptMatch = trimmed.match(/^\/accept(?:\s+(\d+))?$/);
    if (acceptMatch) {
      const target = resolveTarget(acceptMatch[1]);
      if (!target) return false;
      handleApprove(target);
      return true;
    }
    const rejectMatch = trimmed.match(/^\/reject(?:\s+(\d+))?$/);
    if (rejectMatch) {
      const target = resolveTarget(rejectMatch[1]);
      if (!target) return false;
      handleReject(target);
      return true;
    }
    if (trimmed === '/close') {
      onClose();
      return true;
    }
    return contextDispatch(message);
  };

  const activeIndex = liveVideos.findIndex((v) => v.id === activeVideoId);

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
        <InboxHeader
          reviewCount={liveVideos.length}
          pendingCount={pendingVideos.length}
          activeIndex={activeIndex}
          onClose={onClose}
        />

        {/* Scrollable unified grid */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {allClear ? (
            <div className="flex-1 flex items-center justify-center animate-in fade-in duration-300">
              <InboxAllClear />
            </div>
          ) : renderedVideos.length > 0 || pendingVideos.length > 0 ? (
            <div className="flex flex-wrap gap-4">
              {renderedVideos.map((video) => {
                const liveIdx = liveVideos.findIndex((v) => v.id === video.id);
                return (
                  <InboxReviewCard
                    key={video.id}
                    video={video}
                    cardNumber={liveIdx >= 0 ? liveIdx + 1 : 0}
                    isActive={video.id === activeVideoId}
                    isExiting={exitingIds.has(video.id)}
                    onApprove={handleApprove}
                    onReject={handleReject}
                    onVideoEnded={handleVideoEnded}
                    onActivate={setActiveVideoId}
                    onExitComplete={handleExitComplete}
                  />
                );
              })}
              {pendingVideos.map((video) => (
                <InboxPendingCard key={video.id} video={video} />
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm font-mono">
              Waiting for generations to complete...
            </div>
          )}
        </div>

        {/* ChatInput bar */}
        <div className="shrink-0 border-t border-border/50 px-6 py-3">
          <ChatInput
            assetSlugs={assetSlugs}
            commands={mergedCommands}
            onSend={handleInboxSend}
            callTool={callTool}
            projectSlug={projectSlug}
            placeholder="type /accept, /reject, /close..."
          />
        </div>
      </div>
    </>
  );
}
