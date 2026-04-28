import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { Check, Eraser, Magnet, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatInput } from '@/components/ui/ChatInput';
import { CommandButton } from './CommandButton';
import { CloseButton } from '@/components/gen/ui/CloseButton';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import type { UseMcpResult } from 'use-mcp/react';
import type { MediaItem } from '@/components/sidebar/types';
import type { ExecuteButtonState } from './types';

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

type TrimMode = 'keep' | 'remove';

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

function clampPct(v: number): number {
  return Math.max(0, Math.min(100, v));
}

function snapToNearest(timeSec: number, points: number[]): number {
  if (points.length === 0) return timeSec;
  let best = timeSec;
  let bestDist = Infinity;
  for (const p of points) {
    const d = Math.abs(timeSec - p);
    if (d < bestDist) { bestDist = d; best = p; }
  }
  return best;
}

function snapRangePct(range: TrimRange, duration: number, points: number[]): TrimRange {
  if (points.length === 0 || duration <= 0) return range;
  let s = snapToNearest((range.startPct / 100) * duration, points);
  let e = snapToNearest((range.endPct / 100) * duration, points);
  // If both snap to the same point, push end to the next snap point
  if (s === e && points.length > 1) {
    const idx = points.indexOf(e);
    if (idx < points.length - 1) e = points[idx + 1];
    else if (idx > 0) s = points[idx - 1];
  }
  const sp = clampPct((s / duration) * 100);
  const ep = clampPct((e / duration) * 100);
  return { startPct: Math.min(sp, ep), endPct: Math.max(sp, ep) };
}

interface SnapMarker { timeSec: number; label: string; }

interface AnalysisScene { timestamp?: number; description?: string; }
interface AnalysisJson { scenes?: AnalysisScene[]; }

function parseTimestamp(s: string): number | undefined {
  const trimmed = s.trim();
  if (!trimmed) return undefined;
  if (trimmed.includes(':')) {
    const parts = trimmed.split(':');
    if (parts.length === 2 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
      return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
    }
    if (parts.length === 3 && parts.every((p) => /^\d+(\.\d+)?$/.test(p))) {
      return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
    }
    return undefined;
  }
  const n = Number(trimmed);
  return Number.isFinite(n) ? n : undefined;
}

interface TimeMark { timeSec: number; label: string; }

function buildTimeMarks(duration: number): TimeMark[] {
  const intervals = [5, 10, 15, 20, 30, 60, 120, 300];
  let interval = intervals.find((i) => duration / i <= 7) ?? Math.ceil(duration / 6);
  if (interval < 1) interval = 1;
  const marks: TimeMark[] = [];
  for (let t = 0; t <= duration; t += interval) {
    marks.push({ timeSec: t, label: formatDuration(t) });
  }
  // Add final duration mark only if not already covered
  const last = marks[marks.length - 1];
  if (!last || Math.abs(last.timeSec - duration) > 0.5) {
    marks.push({ timeSec: duration, label: formatDuration(duration) });
  }
  return marks;
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

  // Derived values needed by callbacks
  const duration = item?.duration ?? 0;

  // Selection state
  const [trimRange, setTrimRange] = useState<TrimRange | null>(null);
  const [trimMode, setTrimMode] = useState<TrimMode>('keep');
  const [trimState, setTrimState] = useState<ExecuteButtonState | undefined>(undefined);
  const [snapEnabled, setSnapEnabled] = useState(true);
  const [markers, setMarkers] = useState<SnapMarker[]>([]);
  const draggingRef = useRef<false | 'create' | 'start' | 'end'>(false);
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
    return () => {
      setTrimRange(null);
    };
  }, [assetId]);

  // Fetch transcript when asset changes
  useEffect(() => {
    if (!open || !assetId || !projectSlug) {
      return () => {
        setWords([]);
      };
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

  // Fetch analysis markers when asset changes
  useEffect(() => {
    if (!open || !assetId || !projectSlug) {
      return () => {
        setMarkers([]);
      };
    }
    let cancelled = false;
    fetch(`/files/${projectSlug}/${assetId}/.original.analysis.json`)
      .then((res) => {
        if (!res.ok) throw new Error('no analysis');
        return res.json() as Promise<AnalysisJson>;
      })
      .then((data) => {
        if (cancelled) return;
        const scenes = (data?.scenes ?? []).filter(
          (s): s is AnalysisScene & { timestamp: number } => typeof s.timestamp === 'number',
        );
        setMarkers(scenes.map((s) => ({ timeSec: s.timestamp, label: s.description ?? '' })));
      })
      .catch(() => { if (!cancelled) setMarkers([]); });
    return () => { cancelled = true; };
  }, [open, assetId, projectSlug]);

  // Snap points: all marker positions combined, or 250ms grid fallback
  const snapPoints = useMemo(() => {
    if (duration <= 0) return [];
    const points = new Set<number>([0, duration]);
    // Analysis scene markers
    for (const m of markers) points.add(m.timeSec);
    // Frame badge positions
    const frameUrls = item?.frameDirs?.original_frames;
    if (frameUrls && frameUrls.length > 0) {
      const count = Math.min(frameUrls.length, 8);
      for (let i = 0; i < count; i++) {
        points.add(((i + 0.5) / count) * duration);
      }
    }
    // Always include 250ms grid
    for (let t = 0; t <= duration; t += 0.25) points.add(t);
    return Array.from(points).sort((a, b) => a - b);
  }, [markers, duration, item?.frameDirs?.original_frames]);

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

  // Waveform mouse handlers — create new selection or drag existing handles
  const handleWaveformMouseDown = useCallback((e: React.MouseEvent) => {
    const rect = waveformRef.current?.getBoundingClientRect();
    if (!rect) return;
    const pct = pctFromMouse(e, rect);
    // If an existing range, check if click is near a handle (within 2% of width)
    if (trimRange) {
      const hitZone = 2;
      if (Math.abs(pct - trimRange.startPct) <= hitZone) {
        draggingRef.current = 'start';
        return;
      }
      if (Math.abs(pct - trimRange.endPct) <= hitZone) {
        draggingRef.current = 'end';
        return;
      }
    }
    // Otherwise create a new selection
    draggingRef.current = 'create';
    dragStartPctRef.current = pct;
    setTrimRange({ startPct: pct, endPct: pct });
  }, [trimRange]);

  // Global mousemove + mouseup for waveform dragging (works outside the waveform)
  useEffect(() => {
    if (!open) return;
    const handleMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      const rect = waveformRef.current?.getBoundingClientRect();
      if (!rect) return;
      const pct = Math.max(0, Math.min(100, ((e.clientX - rect.left) / rect.width) * 100));
      const mode = draggingRef.current;
      if (mode === 'create') {
        const anchor = dragStartPctRef.current;
        setTrimRange({ startPct: Math.min(anchor, pct), endPct: Math.max(anchor, pct) });
      } else if (mode === 'start') {
        setTrimRange((prev) => prev ? { startPct: Math.min(pct, prev.endPct), endPct: Math.max(pct, prev.endPct) } : prev);
      } else if (mode === 'end') {
        setTrimRange((prev) => prev ? { startPct: Math.min(prev.startPct, pct), endPct: Math.max(prev.startPct, pct) } : prev);
      }
    };
    const handleUp = () => {
      const mode = draggingRef.current;
      if (!mode) return;
      draggingRef.current = false;
      setTrimRange((prev) => {
        if (!prev) return null;
        if (mode === 'create' && Math.abs(prev.endPct - prev.startPct) < 0.5) return null;
        if (snapEnabled && snapPoints.length > 0 && duration > 0) {
          return snapRangePct(prev, duration, snapPoints);
        }
        return prev;
      });
    };
    window.addEventListener('mousemove', handleMove);
    window.addEventListener('mouseup', handleUp);
    return () => {
      window.removeEventListener('mousemove', handleMove);
      window.removeEventListener('mouseup', handleUp);
    };
  }, [open, snapEnabled, snapPoints, duration]);

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

  const [trimError, setTrimError] = useState<string | null>(null);

  const handleTrim = useCallback(async (mode: TrimMode, startSec: number, endSec: number) => {
    if (!assetId || !projectSlug) return;
    setTrimError(null);
    setTrimState('charging');
    await new Promise((r) => setTimeout(r, 400));
    setTrimState('processing');
    try {
      const result = await callTool('trim_video', {
        asset_id: assetId,
        project_slug: projectSlug,
        ...(mode === 'keep'
          ? { trim_start: startSec, trim_end: endSec }
          : { cut_start: startSec, cut_end: endSec }),
      });
      if (result && 'isError' in result && result.isError) {
        const msg = Array.isArray(result.content) && result.content[0]?.text
          ? String(result.content[0].text)
          : 'Trim failed';
        setTrimError(msg);
        setTrimState(undefined);
        return;
      }
      setTrimState('success');
      setTimeout(() => {
        setTrimState(undefined);
        setTrimRange(null);
        onClose();
      }, 1200);
    } catch (err) {
      setTrimError(err instanceof Error ? err.message : 'Trim failed');
      setTrimState(undefined);
    }
  }, [assetId, projectSlug, callTool, onClose]);

  const handleSend = async (message: string) => {
    const cmd = message.trim().toLowerCase();
    if (cmd === '/close') { onClose(); return true; }
    if (cmd === '/clear') { handleClear(); return true; }
    if (cmd === '/snap' || cmd === '/snap on' || cmd === '/snap off') {
      if (cmd === '/snap on') setSnapEnabled(true);
      else if (cmd === '/snap off') setSnapEnabled(false);
      else setSnapEnabled((prev) => !prev);
      return true;
    }
    if (cmd.startsWith('/select')) {
      const args = cmd.slice(7).trim();
      if (args && duration > 0) {
        const parts = args.split(/\s+/);
        const startSec = parseTimestamp(parts[0]);
        const endSec = parts[1] ? parseTimestamp(parts[1]) : undefined;
        if (startSec !== undefined) {
          const startPct = clampPct((startSec / duration) * 100);
          const endPct = endSec !== undefined ? clampPct((endSec / duration) * 100) : startPct;
          let range: TrimRange = { startPct: Math.min(startPct, endPct), endPct: Math.max(startPct, endPct) };
          if (snapEnabled && snapPoints.length > 0) {
            range = snapRangePct(range, duration, snapPoints);
          }
          setTrimRange(range);
        }
      }
      return true;
    }
    if ((cmd.startsWith('/keep') || cmd.startsWith('/trim')) && trimRange && duration > 0) {
      const startSec = (trimRange.startPct / 100) * duration;
      const endSec = (trimRange.endPct / 100) * duration;
      handleTrim('keep', startSec, endSec);
      return true;
    }
    if ((cmd.startsWith('/remove') || cmd.startsWith('/cut')) && trimRange && duration > 0) {
      const startSec = (trimRange.startPct / 100) * duration;
      const endSec = (trimRange.endPct / 100) * duration;
      handleTrim('remove', startSec, endSec);
      return true;
    }
    return contextDispatch(message);
  };

  if (!open) return null;

  const waveform = item?.waveform ?? [];
  const videoSrc = item?.filePath ?? '';
  const posterSrc = item?.thumbnailSrc ?? '';
  const frameBadges = buildFrameBadges(item);
  const selectedStartSec = trimRange && duration > 0 ? (trimRange.startPct / 100) * duration : 0;
  const selectedEndSec = trimRange && duration > 0 ? (trimRange.endPct / 100) * duration : 0;
  const selectedDurationSec = Math.max(0, selectedEndSec - selectedStartSec);
  const resultDurationSec = trimMode === 'keep' ? selectedDurationSec : Math.max(0, duration - selectedDurationSec);
  const modeClasses = trimMode === 'keep'
    ? {
        tint: 'bg-emerald-500/24',
        line: 'bg-emerald-400',
        text: 'text-emerald-300',
        border: 'border-emerald-400/60',
        soft: 'bg-emerald-500/10',
      }
    : {
        tint: 'bg-red-500/24',
        line: 'bg-red-400',
        text: 'text-red-300',
        border: 'border-red-400/60',
        soft: 'bg-red-500/10',
      };
  const actionCommand = trimMode === 'keep' ? '/keep selection' : '/remove selection';

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
          <span className="font-mono text-xs tracking-widest text-zinc-400 uppercase">Trimming</span>
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
          <div className="relative w-[320px] shrink-0 flex flex-col border-l border-cyan-500/30 bg-gradient-to-b from-zinc-950 to-zinc-900/90">
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
                            'inline-block text-base font-sans cursor-pointer select-none px-0.5 mx-0.5 my-0.5 rounded-sm',
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

        <div className="shrink-0 px-6 py-3 flex flex-col gap-2">
          <div className="grid grid-cols-[auto_1fr_auto] items-stretch gap-3">
            <div className="flex rounded border border-zinc-700/70 bg-black/40 overflow-hidden">
              <button
                type="button"
                className={cn(
                  'h-10 px-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider transition-colors',
                  trimMode === 'keep'
                    ? 'bg-emerald-500/18 text-emerald-300'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900',
                )}
                onClick={() => setTrimMode('keep')}
              >
                <Check className="w-4 h-4" />
                Keep Selection
              </button>
              <button
                type="button"
                className={cn(
                  'h-10 px-3 flex items-center gap-2 border-l border-zinc-700/70 font-mono text-[11px] uppercase tracking-wider transition-colors',
                  trimMode === 'remove'
                    ? 'bg-red-500/18 text-red-300'
                    : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900',
                )}
                onClick={() => setTrimMode('remove')}
              >
                <Trash2 className="w-4 h-4" />
                Remove Selection
              </button>
            </div>

            <div className={cn('min-w-0 rounded border px-3 py-2 font-mono', modeClasses.border, modeClasses.soft)}>
              {trimRange && duration > 0 ? (
                <div className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-3 text-[11px]">
                  <span className={cn('uppercase tracking-widest', modeClasses.text)}>
                    {trimMode === 'keep' ? 'Keeping selected range' : 'Removing selected range'}
                  </span>
                  <span className="text-zinc-500">
                    {formatDuration(selectedStartSec)} to {formatDuration(selectedEndSec)}
                  </span>
                  <span className="text-zinc-600 truncate">
                    selected {formatDuration(selectedDurationSec)}
                  </span>
                  <span className="text-zinc-400">
                    result {formatDuration(resultDurationSec)}
                  </span>
                </div>
              ) : (
                <div className="text-[11px] uppercase tracking-widest text-zinc-500">Drag across the waveform to select a range</div>
              )}
            </div>

            <div className="flex items-center gap-2">
              <CommandButton command="/clear" icon={<Eraser className="w-4 h-4" />} size="default" onClick={handleClear} />
              <CommandButton
                command={snapEnabled ? '/snap off' : '/snap on'}
                icon={<Magnet className="w-4 h-4" />}
                size="default"
                variant={snapEnabled ? 'violet' : 'default'}
                onClick={() => setSnapEnabled((prev) => !prev)}
                state={duration <= 0 ? 'disabled' : undefined}
                disabledReason="No video loaded"
              />
              {trimError && (
                <span className="text-[11px] font-mono text-red-400 truncate max-w-[300px]">{trimError}</span>
              )}
              <CommandButton
                command={actionCommand}
                icon={trimMode === 'keep' ? <Check className="w-4 h-4" /> : <Trash2 className="w-4 h-4" />}
                size="default"
                variant={trimMode === 'keep' ? 'emerald' : 'fuchsia'}
                state={trimState ?? (trimRange ? undefined : 'disabled')}
                disabledReason="Drag on the waveform to select a trim range"
                onClick={() => {
                  if (trimRange && duration > 0 && !trimState) {
                    setTrimError(null);
                    const startSec = (trimRange.startPct / 100) * duration;
                    const endSec = (trimRange.endPct / 100) * duration;
                    handleTrim(trimMode, startSec, endSec);
                  }
                }}
              />
            </div>
          </div>

          <div className="relative overflow-visible" style={{ height: 96 }}>
            <div
              ref={waveformRef}
              data-waveform
              className="relative bg-black border border-zinc-700/50 rounded-md overflow-hidden flex items-end select-none cursor-col-resize"
              style={{ height: 96 }}
              onMouseDown={handleWaveformMouseDown}
            >
              {waveform.length > 0 && <WaveformBars data={waveform} />}

              {/* Trim selection overlay */}
              {trimRange && (
                <>
                  {trimMode === 'keep' && (
                    <>
                      <div
                        className="absolute top-0 bottom-0 left-0 bg-black/55 pointer-events-none z-10"
                        style={{ width: `${trimRange.startPct}%` }}
                      />
                      <div
                        className="absolute top-0 bottom-0 right-0 bg-black/55 pointer-events-none z-10"
                        style={{ width: `${100 - trimRange.endPct}%` }}
                      />
                    </>
                  )}
                  <div
                    className={cn('absolute top-0 bottom-0 pointer-events-none z-10', modeClasses.tint)}
                    style={{ left: `${trimRange.startPct}%`, width: `${trimRange.endPct - trimRange.startPct}%` }}
                  />
                  <div
                    className={cn(
                      'absolute top-7 z-30 -translate-x-1/2 rounded border bg-zinc-950/90 px-2 py-0.5 font-mono text-[10px] uppercase tracking-widest pointer-events-none',
                      modeClasses.text,
                      modeClasses.border,
                    )}
                    style={{ left: `${(trimRange.startPct + trimRange.endPct) / 2}%` }}
                  >
                    {trimMode === 'keep' ? 'Keep' : 'Remove'}
                  </div>
                  {/* Start handle — visible line + wide grab zone */}
                  <div
                    className="absolute top-0 bottom-0 z-20 flex items-stretch cursor-ew-resize"
                    style={{ left: `${trimRange.startPct}%`, transform: 'translateX(-50%)', width: 12 }}
                    onMouseDown={(e) => { e.stopPropagation(); draggingRef.current = 'start'; }}
                  >
                    <div className={cn('w-0.5 mx-auto', modeClasses.line)} />
                  </div>
                  {/* End handle — visible line + wide grab zone */}
                  <div
                    className="absolute top-0 bottom-0 z-20 flex items-stretch cursor-ew-resize"
                    style={{ left: `${trimRange.endPct}%`, transform: 'translateX(-50%)', width: 12 }}
                    onMouseDown={(e) => { e.stopPropagation(); draggingRef.current = 'end'; }}
                  >
                    <div className={cn('w-0.5 mx-auto', modeClasses.line)} />
                  </div>
                  {duration > 0 && (
                    <>
                      <span
                        className={cn('absolute top-0.5 text-[9px] font-mono pointer-events-none z-30 -translate-x-1/2', modeClasses.text)}
                        style={{ left: `${trimRange.startPct}%` }}
                      >
                        {formatDuration((trimRange.startPct / 100) * duration)}
                      </span>
                      <span
                        className={cn('absolute top-0.5 text-[9px] font-mono pointer-events-none z-30 -translate-x-1/2', modeClasses.text)}
                        style={{ left: `${trimRange.endPct}%` }}
                      >
                        {formatDuration((trimRange.endPct / 100) * duration)}
                      </span>
                    </>
                  )}
                </>
              )}

              {/* 250ms grid notches — rendered from top down so bars don't cover them */}
              {duration > 0 && (() => {
                const ticks: React.ReactNode[] = [];
                for (let t = 0.25; t < duration; t += 0.25) {
                  const isSec = Math.abs(t - Math.round(t)) < 0.01;
                  ticks.push(
                    <div
                      key={t}
                      className="absolute pointer-events-none z-[15]"
                      style={{
                        left: `${(t / duration) * 100}%`,
                        top: 0,
                        width: 1,
                        height: isSec ? 12 : 6,
                        backgroundColor: isSec ? 'rgba(161,161,170,0.6)' : 'rgba(161,161,170,0.3)',
                      }}
                    />
                  );
                }
                return ticks;
              })()}
            </div>

            {/* Analysis scene markers — vertically centered on waveform */}
            {duration > 0 && markers.length > 0 && markers.filter((m) => m.timeSec > 0 && m.timeSec < duration).map((m, i) => (
              <div
                key={`scene-${i}`}
                className="absolute z-20 group"
                style={{ left: `${(m.timeSec / duration) * 100}%`, top: 0, bottom: 0 }}
              >
                {/* Full-height line */}
                <div className="absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 bg-amber-400/40" />
                {/* Exclamation circle — centered */}
                <div
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center w-4 h-4 rounded-full bg-amber-500 border border-amber-300 cursor-pointer shadow-[0_0_8px_rgba(245,158,11,0.5)]"
                >
                  <span className="text-[13px] font-black text-zinc-900 leading-none">!</span>
                </div>
                {/* Hover tooltip above waveform */}
                <div className="absolute left-1/2 -translate-x-1/2 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50 w-48 p-2 rounded bg-zinc-900/95 border border-amber-400/50 shadow-[0_0_12px_rgba(245,158,11,0.3)]"
                  style={{ bottom: 'calc(100% + 8px)' }}
                >
                  <span className="text-[9px] font-mono text-amber-300 block mb-0.5">{formatDuration(m.timeSec)}</span>
                  <span className="text-[10px] text-zinc-300 leading-tight line-clamp-3">{m.label}</span>
                </div>
              </div>
            ))}

            {/* Thumbnail markers — vertically centered on waveform */}
            {frameBadges.filter((b) => b.percent > 1 && b.percent < 99).map((badge, i) => (
              <div
                key={`frame-${i}`}
                className="absolute z-20 group"
                style={{ left: `${badge.percent}%`, top: 0, bottom: 0 }}
              >
                {/* Full-height line */}
                <div className="absolute inset-y-0 left-1/2 w-px -translate-x-1/2 bg-cyan-500/30" />
                {/* Micro thumbnail — centered */}
                <div
                  className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-8 h-6 rounded-sm border border-cyan-400/60 bg-cover bg-center cursor-pointer shadow-[0_0_6px_rgba(34,211,238,0.3)]"
                  style={{ backgroundImage: `url(${badge.src})` }}
                />
                {/* Hover preview above waveform */}
                <div className="absolute left-1/2 -translate-x-1/2 pointer-events-none opacity-0 group-hover:opacity-100 transition-opacity z-50 flex flex-col items-center gap-1"
                  style={{ bottom: 'calc(100% + 8px)' }}
                >
                  <div
                    className="w-[140px] h-[94px] rounded border border-cyan-400/60 bg-cover bg-center shadow-[0_0_12px_rgba(34,211,238,0.5)]"
                    style={{ backgroundImage: `url(${badge.src})` }}
                  />
                  <span className="text-[9px] font-mono text-cyan-400/80 whitespace-nowrap">{badge.time}</span>
                </div>
              </div>
            ))}

            {/* Playhead */}
            <div
              className="absolute top-0 pointer-events-none z-30"
              style={{
                left: `${playheadPercent}%`,
                width: 3,
                height: 96,
                marginLeft: -1,
                backgroundColor: 'rgb(34, 211, 238)',
                filter: 'drop-shadow(0 0 6px rgba(34, 211, 238, 0.7))',
              }}
            />
          </div>

          {/* Time marks — positioned by actual time */}
          {duration > 0 && (
            <div className="relative mt-1" style={{ height: 16 }}>
              {buildTimeMarks(duration).map((mark, i) => {
                const pct = (mark.timeSec / duration) * 100;
                return (
                  <span
                    key={i}
                    className="absolute text-[10px] font-mono text-zinc-500 -translate-x-1/2"
                    style={{ left: `${pct}%` }}
                  >
                    {mark.label}
                  </span>
                );
              })}
            </div>
          )}
        </div>

        {/* ChatInput bar */}
        <div className="shrink-0 border-t border-border/50 px-6 py-3">
          <ChatInput
            assetSlugs={assetSlugs}
            commands={contextCommands}
            onSend={handleSend}
            callTool={callTool}
            projectSlug={projectSlug}
            placeholder="type /select 0:05 0:12, /keep, or /remove..."
          />
        </div>
      </div>
    </>
  );
}

// ── Waveform bars ──

function WaveformBars({ data }: { data: number[] }) {
  const maxVal = Math.max(...data, 1);

  return (
    <div className="flex items-end w-full h-full gap-[0.5px] px-px">
      {data.map((val, i) => (
        <div
          key={i}
          className="flex-1 min-w-0 bg-cyan-500/50 rounded-t-[0.5px]"
          style={{ height: `${Math.max((val / maxVal) * 100, 2)}%` }}
        />
      ))}
    </div>
  );
}

// ── Frame badge builder ──

interface FrameBadge {
  percent: number;
  src: string;
  time: string;
}

function buildFrameBadges(item: MediaItem | null): FrameBadge[] {
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
