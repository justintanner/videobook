import { useState, useEffect, useRef } from 'react';
import { Scissors } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatInput } from '@/components/ui/ChatInput';
import { CommandButton } from './CommandButton';
import { CloseButton } from '@/components/gen/ui/CloseButton';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import type { UseMcpResult } from 'use-mcp/react';

// ── Mock data (static shell — real data integration is a follow-up) ──

const TRIM_PLAYHEAD_POS = 42;

const trimDemoWords = [
  { text: 'The', start: 0.0, end: 0.2 },
  { text: 'quick', start: 0.2, end: 0.5 },
  { text: 'brown', start: 0.5, end: 0.8 },
  { text: 'fox', start: 0.8, end: 1.1 },
  { text: 'jumps', start: 1.1, end: 1.5 },
  { text: 'over', start: 1.5, end: 1.8 },
  { text: 'the', start: 1.8, end: 2.0 },
  { text: 'lazy', start: 2.0, end: 2.4 },
  { text: 'dog.', start: 2.4, end: 2.8 },
  { text: 'A', start: 3.0, end: 3.1 },
  { text: 'second', start: 3.1, end: 3.5 },
  { text: 'sentence', start: 3.5, end: 4.0 },
  { text: 'appears', start: 4.0, end: 4.4 },
  { text: 'here', start: 4.4, end: 4.7 },
  { text: 'with', start: 4.7, end: 5.0 },
  { text: 'more', start: 5.0, end: 5.3 },
  { text: 'words.', start: 5.3, end: 5.7 },
  { text: 'Then', start: 6.0, end: 6.2 },
  { text: 'the', start: 6.2, end: 6.4 },
  { text: 'narrator', start: 6.4, end: 6.9 },
  { text: 'continues', start: 6.9, end: 7.4 },
  { text: 'speaking', start: 7.4, end: 7.9 },
  { text: 'about', start: 7.9, end: 8.2 },
  { text: 'the', start: 8.2, end: 8.4 },
  { text: 'product.', start: 8.4, end: 8.9 },
];

const trimDemoCutRegions = [
  { startPercent: 18, widthPercent: 12 },
  { startPercent: 62, widthPercent: 8 },
];

const trimSelectedWordIndices = new Set([5, 6, 7]);
const trimActiveWordIndex = 11;

const trimStripedBg = 'repeating-linear-gradient(-45deg, rgba(239,68,68,0.15) 0px 4px, rgba(239,68,68,0.35) 4px 8px)';

const trimTimelineBadges = Array.from({ length: 6 }, (_, i) => ({
  percent: ((i + 0.5) / 6) * 100,
  src: i % 2 === 0 ? '/styleguide-img-cover.jpg' : '/styleguide-vid-purple-grind.jpg',
  time: `0:${Math.round(((i + 0.5) / 6) * 10).toString().padStart(2, '0')}`,
}));

// ── Component ──

interface TrimEditorProps {
  open: boolean;
  assetId: string | null;
  onClose: () => void;
  assetSlugs: string[];
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
}

export function TrimEditor({
  open,
  assetId,
  onClose,
  assetSlugs,
  callTool,
  projectSlug,
}: TrimEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  // Two-phase open: mount then animate in
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => setVisible(true), 0);
      return () => clearTimeout(t);
    } else {
      const t = setTimeout(() => setVisible(false), 0);
      return () => clearTimeout(t);
    }
  }, [open]);

  // Escape key handler
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  // Focus lock
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
          || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'BUTTON') return;
      if (target.isContentEditable) return;
      if (target.closest('[data-radix-popper-content-wrapper]')) return;
      const dialog = dialogRef.current;
      if (!dialog || !dialog.contains(target)) return;
      e.preventDefault();
      const input = dialog.querySelector<HTMLInputElement>('[data-testid="input-chat"]');
      input?.focus();
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const { dispatch: contextDispatch, commands: contextCommands } = useCommandDispatch();

  const handleSend = async (message: string) => {
    if (message.trim() === '/close') {
      onClose();
      return true;
    }
    return contextDispatch(message);
  };

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
        ref={dialogRef}
        role="dialog"
        aria-label="Trim video"
        className={cn(
          'fixed inset-0 z-[101] bg-zinc-950 flex flex-col transition-all duration-300',
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95'
        )}
      >
        {/* Header */}
        <div className="h-12 shrink-0 flex items-center justify-between px-5 border-b border-zinc-700/60 bg-gradient-to-r from-zinc-900 via-zinc-900/95 to-zinc-950 relative">
          <span className="font-mono text-xs tracking-widest text-zinc-400 uppercase">Editing</span>
          <div className="absolute inset-x-0 flex justify-center pointer-events-none">
            <span className="font-mono text-xs tracking-widest text-zinc-400">{assetId ? `@${assetId}` : ''}</span>
          </div>
          <CloseButton onClick={onClose} />
        </div>

        {/* Video + Transcript */}
        <div className="flex-1 min-h-0 flex overflow-hidden relative">
          <div className="flex-1 min-w-0 flex items-center justify-center bg-black">
            <video loop playsInline controls muted poster="/styleguide-img-cover.jpg" src="/fixtures/video-frost.mp4" className="w-full h-full object-contain" />
          </div>
          <div className="relative w-[280px] shrink-0 flex flex-col border-l border-cyan-500/30 bg-gradient-to-b from-zinc-950 to-zinc-900/90">
            <div className="shrink-0 px-4 py-2.5 border-b border-zinc-700/50 bg-zinc-900/80 flex items-center justify-between">
              <span className="text-[10px] font-mono tracking-[0.25em] uppercase text-cyan-500/70">Transcript</span>
              <span className="text-[10px] font-mono text-zinc-500">25 words &middot; 8.9s</span>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 leading-relaxed scrollbar-hide">
              <div className="leading-loose">
                {trimDemoWords.map((word, i) => {
                  const isSelected = trimSelectedWordIndices.has(i);
                  const isActive = i === trimActiveWordIndex;
                  return (
                    <span key={i}>
                      <span className={cn('inline-block text-sm font-sans cursor-pointer select-none px-0.5 mx-0.5 my-0.5 rounded-sm', isSelected ? 'text-red-400/60 line-through decoration-red-500/80' : isActive ? 'text-cyan-300 bg-cyan-500/15' : 'text-zinc-300')}>{word.text}</span>
                      {word.text.endsWith('.') && <br />}
                    </span>
                  );
                })}
              </div>
            </div>
            <div className="shrink-0 px-3 py-3 flex justify-end">
              <CommandButton command="/trim" icon={<Scissors className="w-5 h-5" />} size="lg" />
            </div>
          </div>
        </div>

        {/* Waveform */}
        <div className="shrink-0 px-6 py-3">
          <div className="relative overflow-visible" style={{ height: 80 }}>
            <div className="relative bg-black border border-zinc-700/50 rounded-md overflow-hidden" style={{ height: 80 }}>
              {trimDemoCutRegions.map((region, i) => (
                <div key={i} className="absolute top-0 bottom-0 pointer-events-none z-10" style={{ left: `${region.startPercent}%`, width: `${region.widthPercent}%`, background: trimStripedBg }} />
              ))}
            </div>

            {/* Thumbnail badges */}
            {trimTimelineBadges.map((badge, i) => {
              const inCut = trimDemoCutRegions.some(
                (r) => badge.percent >= r.startPercent && badge.percent <= r.startPercent + r.widthPercent,
              );
              const isStuckHover = i === 2;
              return (
                <div
                  key={i}
                  className={cn('absolute z-20', !isStuckHover && 'group')}
                  style={{
                    left: `${badge.percent}%`,
                    top: '50%',
                    transform: 'translate(-50%, -50%)',
                  }}
                >
                  <div className={cn(
                    'absolute bottom-full left-1/2 -translate-x-1/2 mb-1 pointer-events-none z-40 transition-opacity',
                    isStuckHover ? 'opacity-100' : 'opacity-0 group-hover:opacity-100',
                  )}>
                    <span className="text-[9px] font-mono text-cyan-400/70 whitespace-nowrap">{badge.time}</span>
                  </div>
                  <div
                    className={cn(
                      'border border-cyan-500/30 bg-cover bg-center',
                      isStuckHover
                        ? 'w-24 h-[72px] -translate-y-[calc(100%+4px)] shadow-[0_0_12px_rgba(34,211,238,0.4)] border-cyan-400/60 z-40 rounded-md'
                        : 'w-6 h-6 rounded-sm transition-all duration-200 ease-out group-hover:w-24 group-hover:h-[72px] group-hover:-translate-y-[calc(100%+4px)] group-hover:shadow-[0_0_12px_rgba(34,211,238,0.4)] group-hover:border-cyan-400/60 group-hover:z-40 group-hover:rounded-md',
                      inCut && 'opacity-50',
                    )}
                    style={{ backgroundImage: `url(${badge.src})` }}
                  />
                </div>
              );
            })}

            <div className="absolute top-0 pointer-events-none z-30" style={{ left: `${TRIM_PLAYHEAD_POS}%`, width: 3, height: 80, marginLeft: -1, backgroundColor: 'rgb(34, 211, 238)', filter: 'drop-shadow(0 0 6px rgba(34, 211, 238, 0.7))' }} />
          </div>
        </div>

        {/* ChatInput bar */}
        <div className="shrink-0 border-t border-border/50 px-6 py-3">
          <ChatInput
            assetSlugs={assetSlugs}
            commands={contextCommands}
            onSend={handleSend}
            callTool={callTool}
            projectSlug={projectSlug}
            placeholder="type /trim @slug 0:05 0:12..."
          />
        </div>
      </div>
    </>
  );
}
