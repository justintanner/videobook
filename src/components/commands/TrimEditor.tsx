import { useState, useEffect, useRef, useCallback } from 'react';
import { Scissors, Eraser } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatInput } from '@/components/ui/ChatInput';
import { CommandButton } from './CommandButton';
import { CloseButton } from '@/components/gen/ui/CloseButton';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import type { UseMcpResult } from 'use-mcp/react';
import type { MediaItem } from '@/components/sidebar/types';

// ── Types ──

interface TranscriptWord {
  text: string;
  start: number;
  end: number;
}

interface TrimRange {
  startPct: number;
  endPct: number;
}

// ── Helpers ──

function formatDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function formatBadgeTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${s.toString().padStart(2, '0')}`;
}

interface ElevenLabsWord {
  text?: string;
  word?: string;
  start?: number;
  end?: number;
  type?: string;
}

interface ElevenLabsSegment {
  words?: ElevenLabsWord[];
}

interface ElevenLabsJson {
  segments?: ElevenLabsSegment[];
  words?: ElevenLabsWord[];
}

function parseTranscriptWords(data: ElevenLabsJson): TranscriptWord[] {
  const rawWords: ElevenLabsWord[] = [];

  if (data.segments && data.segments.length > 0) {
    for (const seg of data.segments) {
      if (seg.words) rawWords.push(...seg.words);
    }
  } else if (data.words) {
    rawWords.push(...data.words);
  }

  return rawWords
    .filter((w) => (w.type ?? 'word') === 'word')
    .map((w) => {
      const text = (w.text ?? w.word ?? '').trim();
      if (!text) return null;
      return { text, start: w.start ?? 0, end: w.end ?? 0 };
    })
    .filter((w): w is TranscriptWord => w !== null);
}

function pctFromMouse(e: React.MouseEvent, rect: DOMRect): number {
  return Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
}

// ── Component ──

interface TrimEditorProps {
  open: boolean;
  assetId: string | null;
  item: MediaItem | null;
  onClose: () => void;
  assetSlugs: string[];
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
}

export function TrimEditor({
  open,
  assetId,
  item,
  onClose,
  assetSlugs,
  callTool,
  projectSlug,
}: TrimEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [words, setWords] = useState<TranscriptWord[]>([]);
  const [playheadPercent, setPlayheadPercent] = useState(0);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);

  // Selection state
  const [trimRange, setTrimRange] = useState<TrimRange | null>(null);
  const draggingRef = useRef(false);
  const dragStartPctRef = useRef(0);

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

  // Reset selection when asset changes
  useEffect(() => {
    setTrimRange(null);
  }, [assetId]);

  // Fetch transcript when asset changes
  useEffect(() => {
    if (!open || !assetId || !projectSlug) {
      setWords([]);
      return;
    }
    let cancelled = false;
    fetch(`/files/${projectSlug}/${assetId}/elevenlabs.json`)
      .then((res) => {
        if (!res.ok) throw new Error('no transcript');
        return res.json() as Promise<ElevenLabsJson>;
      })
      .then((data) => {
        if (!cancelled) setWords(parseTranscriptWords(data));
      })
      .catch(() => {
        if (!cancelled) setWords([]);
      });
    return () => { cancelled = true; };
  }, [open, assetId, projectSlug]);

  // Video timeupdate → playhead + active word
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    const pct = (video.currentTime / video.duration) * 100;
    setPlayheadPercent(pct);

    const t = video.currentTime;
    const idx = words.findIndex((w) => t >= w.start && t <= w.end);
    setActiveWordIndex(idx);
  }, [words]);

  // Waveform mouse handlers — always select mode
  const handleWaveformMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = waveformRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = pctFromMouse(e, rect);
    draggingRef.current = true;
    dragStartPctRef.current = pct;
    setTrimRange({ startPct: pct, endPct: pct });
  }, []);

  const handleWaveformMouseMove = useCallback((e: React.MouseEvent) => {
    if (!draggingRef.current) return;
    const rect = waveformRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = pctFromMouse(e, rect);
    const startPct = dragStartPctRef.current;
    setTrimRange({
      startPct: Math.min(startPct, pct),
      endPct: Math.max(startPct, pct),
    });
  }, []);

  const handleWaveformMouseUp = useCallback(() => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    // Discard clicks with no drag distance
    setTrimRange((prev) => {
      if (prev && Math.abs(prev.endPct - prev.startPct) < 0.5) return null;
      return prev;
    });
  }, []);

  // Global mouseup to catch releases outside waveform
  useEffect(() => {
    if (!open) return;
    const handler = () => {
      if (draggingRef.current) {
        draggingRef.current = false;
        setTrimRange((prev) => {
          if (prev && Math.abs(prev.endPct - prev.startPct) < 0.5) return null;
          return prev;
        });
      }
    };
    window.addEventListener('mouseup', handler);
    return () => window.removeEventListener('mouseup', handler);
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
      if (target.closest('[data-waveform]')) return;
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

  const handleClear = useCallback(() => {
    setTrimRange(null);
  }, []);

  const handleSend = async (message: string) => {
    const cmd = message.trim().toLowerCase();
    if (cmd === '/close') { onClose(); return true; }
    if (cmd === '/clear') { handleClear(); return true; }
    if (cmd === '/select') { /* already in select mode — no-op */ return true; }
    return contextDispatch(message);
  };

  if (!open) return null;

  const duration = item?.duration ?? 0;
  const waveform = item?.waveform ?? [];
  const videoSrc = item?.filePath ?? '';
  const posterSrc = item?.thumbnailSrc ?? '';
  const frameBadges = buildFrameBadges(item, projectSlug);

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
            <video
              ref={videoRef}
              loop
              playsInline
              controls
              muted
              poster={posterSrc || undefined}
              src={videoSrc || undefined}
              className="w-full h-full object-contain"
              onTimeUpdate={handleTimeUpdate}
            />
          </div>
          <div className="relative w-[280px] shrink-0 flex flex-col border-l border-cyan-500/30 bg-gradient-to-b from-zinc-950 to-zinc-900/90">
            <div className="shrink-0 px-4 py-2.5 border-b border-zinc-700/50 bg-zinc-900/80 flex items-center justify-between">
              <span className="text-[10px] font-mono tracking-[0.25em] uppercase text-cyan-500/70">Transcript</span>
              <span className="text-[10px] font-mono text-zinc-500">
                {words.length > 0
                  ? `${words.length} words \u00B7 ${duration > 0 ? formatDuration(duration) : ''}`
                  : duration > 0 ? formatDuration(duration) : ''}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto px-4 py-3 leading-relaxed scrollbar-hide">
              {words.length > 0 ? (
                <div className="leading-loose">
                  {words.map((word, i) => {
                    const isActive = i === activeWordIndex;
                    return (
                      <span key={i}>
                        <span
                          className={cn(
                            'inline-block text-sm font-sans cursor-pointer select-none px-0.5 mx-0.5 my-0.5 rounded-sm',
                            isActive ? 'text-cyan-300 bg-cyan-500/15' : 'text-zinc-300',
                          )}
                          onClick={() => {
                            const video = videoRef.current;
                            if (video) video.currentTime = word.start;
                          }}
                        >
                          {word.text}
                        </span>
                        {word.text.endsWith('.') && <br />}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <div className="flex items-center justify-center h-full">
                  <span className="text-xs font-mono text-zinc-600">No transcript</span>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Tool bar + Waveform */}
        <div className="shrink-0 px-6 py-3 flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <CommandButton command="/select" icon={<Scissors className="w-4 h-4" />} size="default" variant="violet" />
            <CommandButton command="/clear" icon={<Eraser className="w-4 h-4" />} size="default" onClick={handleClear} />
            <div className="flex-1" />
            <CommandButton
              command="/trim"
              icon={<Scissors className="w-4 h-4" />}
              size="default"
              state={trimRange ? undefined : 'disabled'}
              disabledReason="Drag on the waveform to select a trim range"
            />
          </div>

          <div className="relative overflow-visible" style={{ height: 80 }}>
            <div
              ref={waveformRef}
              data-waveform
              className="relative bg-black border border-zinc-700/50 rounded-md overflow-hidden flex items-end select-none cursor-col-resize"
              style={{ height: 80 }}
              onMouseDown={handleWaveformMouseDown}
              onMouseMove={handleWaveformMouseMove}
              onMouseUp={handleWaveformMouseUp}
            >
              {waveform.length > 0 && <WaveformBars data={waveform} />}

              {/* Trim selection overlay */}
              {trimRange && (
                <>
                  <div
                    className="absolute top-0 bottom-0 bg-violet-500/20 pointer-events-none z-10"
                    style={{ left: `${trimRange.startPct}%`, width: `${trimRange.endPct - trimRange.startPct}%` }}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-violet-400 pointer-events-none z-20"
                    style={{ left: `${trimRange.startPct}%` }}
                  />
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-violet-400 pointer-events-none z-20"
                    style={{ left: `${trimRange.endPct}%` }}
                  />
                </>
              )}
            </div>

            {/* Thumbnail badges */}
            {frameBadges.map((badge, i) => (
              <div
                key={i}
                className="absolute z-20 group"
                style={{
                  left: `${badge.percent}%`,
                  top: '50%',
                  transform: 'translate(-50%, -50%)',
                }}
              >
                <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 pointer-events-none z-40 transition-opacity opacity-0 group-hover:opacity-100">
                  <span className="text-[9px] font-mono text-cyan-400/70 whitespace-nowrap">{badge.time}</span>
                </div>
                <div
                  className="border border-cyan-500/30 bg-cover bg-center w-6 h-6 rounded-sm transition-all duration-200 ease-out group-hover:w-24 group-hover:h-[72px] group-hover:-translate-y-[calc(100%+4px)] group-hover:shadow-[0_0_12px_rgba(34,211,238,0.4)] group-hover:border-cyan-400/60 group-hover:z-40 group-hover:rounded-md"
                  style={{ backgroundImage: `url(${badge.src})` }}
                />
              </div>
            ))}

            {/* Playhead */}
            <div
              className="absolute top-0 pointer-events-none z-30"
              style={{
                left: `${playheadPercent}%`,
                width: 3,
                height: 80,
                marginLeft: -1,
                backgroundColor: 'rgb(34, 211, 238)',
                filter: 'drop-shadow(0 0 6px rgba(34, 211, 238, 0.7))',
              }}
            />
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

// ── Waveform bars ──

function WaveformBars({ data }: { data: number[] }) {
  const barCount = Math.min(data.length, 200);
  const step = data.length / barCount;
  const maxVal = Math.max(...data, 1);

  return (
    <div className="flex items-end w-full h-full gap-px px-px">
      {Array.from({ length: barCount }, (_, i) => {
        const idx = Math.floor(i * step);
        const val = data[idx] / maxVal;
        return (
          <div
            key={i}
            className="flex-1 min-w-0 bg-cyan-500/40 rounded-t-sm"
            style={{ height: `${Math.max(val * 100, 2)}%` }}
          />
        );
      })}
    </div>
  );
}

// ── Frame badge builder ──

interface FrameBadge {
  percent: number;
  src: string;
  time: string;
}

function buildFrameBadges(item: MediaItem | null, _projectSlug: string | undefined): FrameBadge[] {
  if (!item || !item.duration) return [];

  const frameUrls = item.frameDirs?.original_frames;
  if (frameUrls && frameUrls.length > 0) {
    const count = Math.min(frameUrls.length, 8);
    const step = Math.max(1, Math.floor(frameUrls.length / count));
    return Array.from({ length: count }, (_, i) => {
      const frameIdx = Math.min(i * step, frameUrls.length - 1);
      const percent = ((i + 0.5) / count) * 100;
      const timeSec = (percent / 100) * item.duration!;
      return {
        percent,
        src: frameUrls[frameIdx],
        time: formatBadgeTime(timeSec),
      };
    });
  }

  const count = 6;
  const thumb = item.thumbnailSrc ?? '';
  if (!thumb) return [];
  return Array.from({ length: count }, (_, i) => {
    const percent = ((i + 0.5) / count) * 100;
    const timeSec = (percent / 100) * item.duration!;
    return { percent, src: thumb, time: formatBadgeTime(timeSec) };
  });
}
