import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { ChatInput } from '@/components/ui/ChatInput';
import { CloseButton } from '@/components/gen/ui/CloseButton';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import type { UseMcpResult } from 'use-mcp/react';
import type { MediaItem } from '@/components/sidebar/types';
import type { ExecuteButtonState } from '@/components/commands/types';
import { VIDEO_EDIT_MAX_SEC } from '@/lib/video-limits';
import { useTranscript } from './useTranscript';
import { useAnalysisMarkers } from './useAnalysisMarkers';
import { useSnapPoints } from './useSnapPoints';
import { useTrimSelection } from './useTrimSelection';
import { Waveform } from './Waveform';
import { TrimToolbar } from './TrimToolbar';
import { buildFrameBadges, buildTimeMarks, clampPct, formatDurationMS, parseTimestamp, snapRangePct } from './utils';
import type { TrimMode, TrimRange } from './types';

interface TrimEditorProps {
  open: boolean;
  assetId: string | null;
  item: MediaItem | null;
  onClose: () => void;
  assetSlugs: string[];
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
}

const SNAP_TOLERANCE_FOR_TYPED_COMMAND = 0.15;

export function TrimEditor({
  open, assetId, item, onClose, assetSlugs, callTool, projectSlug,
}: TrimEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const waveformRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [playheadPercent, setPlayheadPercent] = useState(0);
  const [activeWordIndex, setActiveWordIndex] = useState(-1);
  const [trimMode, setTrimMode] = useState<TrimMode>('keep');
  const [trimState, setTrimState] = useState<ExecuteButtonState | undefined>(undefined);
  const [trimError, setTrimError] = useState<string | null>(null);

  const duration = item?.duration ?? 0;

  const words = useTranscript(open, assetId, projectSlug);
  const markers = useAnalysisMarkers(open, assetId, projectSlug);

  // Two-phase open: mount then animate in.
  useEffect(() => {
    if (open) {
      const t = setTimeout(() => setVisible(true), 0);
      return () => clearTimeout(t);
    }
    const t = setTimeout(() => setVisible(false), 0);
    return () => clearTimeout(t);
  }, [open]);

  const [trimRange, setTrimRange] = useState<TrimRange | null>(null);

  // Cap line position depends on the live selection start (Keep mode only).
  const capPointSec = useMemo(() => {
    if (trimMode !== 'keep' || !trimRange || duration <= 0) return null;
    const startSec = (trimRange.startPct / 100) * duration;
    const cap = startSec + VIDEO_EDIT_MAX_SEC;
    return cap > 0 && cap < duration ? cap : null;
  }, [trimMode, trimRange, duration]);

  const extraSnapPoints = useMemo(() => (capPointSec !== null ? [capPointSec] : undefined), [capPointSec]);
  const snapPoints = useSnapPoints({ duration, markers, item, extraPoints: extraSnapPoints });

  const { handleWaveformMouseDown, startHandleMouseDown, endHandleMouseDown } = useTrimSelection({
    open,
    duration,
    snapPoints,
    waveformRef,
    trimRange,
    setTrimRange,
  });

  // Reset selection when the asset changes — derive a "previous assetId" via
  // useState so we can compare during render and reset without an effect.
  const [prevAssetId, setPrevAssetId] = useState(assetId);
  if (prevAssetId !== assetId) {
    setPrevAssetId(assetId);
    setTrimRange(null);
  }

  // Video timeupdate → playhead + active word.
  const handleTimeUpdate = useCallback(() => {
    const video = videoRef.current;
    if (!video || !video.duration) return;
    setPlayheadPercent((video.currentTime / video.duration) * 100);
    const t = video.currentTime;
    setActiveWordIndex(words.findIndex((w) => t >= w.start && t <= w.end));
  }, [words]);

  // Escape key handler.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) onClose();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Focus lock — clicking dead space focuses the chat input.
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

  const handleClear = useCallback(() => setTrimRange(null), [setTrimRange]);

  const runMcp = useCallback(async (
    name: 'trim_video' | 'split_video',
    args: Record<string, unknown>,
  ) => {
    setTrimError(null);
    setTrimState('charging');
    await new Promise((r) => setTimeout(r, 400));
    setTrimState('processing');
    try {
      const result = await callTool(name, args);
      if (result && 'isError' in result && result.isError) {
        const msg = Array.isArray(result.content) && result.content[0]?.text
          ? String(result.content[0].text)
          : `${name} failed`;
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
      setTrimError(err instanceof Error ? err.message : `${name} failed`);
      setTrimState(undefined);
    }
  }, [callTool, onClose, setTrimRange]);

  const handleAction = useCallback(() => {
    if (!trimRange || duration <= 0 || trimState || !assetId || !projectSlug) return;
    const startSec = (trimRange.startPct / 100) * duration;
    const endSec = (trimRange.endPct / 100) * duration;
    if (trimMode === 'keep') {
      runMcp('trim_video', { asset_id: assetId, project_slug: projectSlug, trim_start: startSec, trim_end: endSec });
    } else if (trimMode === 'remove') {
      runMcp('trim_video', { asset_id: assetId, project_slug: projectSlug, cut_start: startSec, cut_end: endSec });
    } else {
      // split: chunk_a_end = right edge, chunk_b_start = left edge of overlap.
      // (zero-width selection → clean split, both equal.)
      runMcp('split_video', {
        asset_id: assetId,
        project_slug: projectSlug,
        chunk_a_end: endSec,
        chunk_b_start: startSec,
      });
    }
  }, [trimRange, duration, trimState, assetId, projectSlug, trimMode, runMcp]);

  const handleSend = async (message: string): Promise<boolean> => {
    const cmd = message.trim().toLowerCase();
    if (cmd === '/close') { onClose(); return true; }
    if (cmd === '/clear') { handleClear(); return true; }
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
          if (snapPoints.length > 0) {
            range = snapRangePct(range, duration, snapPoints, SNAP_TOLERANCE_FOR_TYPED_COMMAND);
          }
          setTrimRange(range);
        }
      }
      return true;
    }
    if ((cmd.startsWith('/keep') || cmd.startsWith('/trim')) && trimRange && duration > 0) {
      setTrimMode('keep');
      handleAction();
      return true;
    }
    if ((cmd.startsWith('/remove') || cmd.startsWith('/cut')) && trimRange && duration > 0) {
      setTrimMode('remove');
      handleAction();
      return true;
    }
    if (cmd.startsWith('/split') && trimRange && duration > 0) {
      setTrimMode('split');
      handleAction();
      return true;
    }
    return contextDispatch(message);
  };

  const waveform = item?.waveform ?? [];
  const videoSrc = item?.filePath ?? '';
  const posterSrc = item?.thumbnailSrc ?? '';
  const frameBadges = useMemo(() => buildFrameBadges(item), [item]);

  const selectedStartSec = trimRange && duration > 0 ? (trimRange.startPct / 100) * duration : 0;
  const selectedEndSec = trimRange && duration > 0 ? (trimRange.endPct / 100) * duration : 0;
  const selectedDurationSec = Math.max(0, selectedEndSec - selectedStartSec);
  const resultDurationSec = trimMode === 'keep'
    ? selectedDurationSec
    : trimMode === 'remove'
      ? Math.max(0, duration - selectedDurationSec)
      : 0;
  const chunkADurationSec = trimRange && duration > 0 ? selectedEndSec : 0;
  const chunkBDurationSec = trimRange && duration > 0 ? duration - selectedStartSec : 0;

  const placeholder = trimMode === 'split'
    ? 'click on the waveform to set a split point, then /split here'
    : 'type /select 0:05 0:12, /keep, or /remove...';

  if (!open) return null;

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] transition-opacity duration-300',
          visible ? 'opacity-100' : 'opacity-0',
        )}
        onClick={onClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Trim video"
        className={cn(
          'fixed inset-0 z-[101] bg-zinc-950 flex flex-col transition-all duration-300',
          visible ? 'opacity-100 scale-100' : 'opacity-0 scale-95',
        )}
      >
        <div className="h-12 shrink-0 flex items-center justify-between px-5 border-b border-zinc-700/60 bg-gradient-to-r from-zinc-900 via-zinc-900/95 to-zinc-950 relative">
          <span className="font-mono text-xs tracking-widest text-zinc-400 uppercase">Trimming</span>
          <div className="absolute inset-x-0 flex justify-center pointer-events-none">
            <span className="font-mono text-xs tracking-widest text-zinc-400">{assetId ? `@${assetId}` : ''}</span>
          </div>
          <CloseButton onClick={onClose} />
        </div>

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
                  ? `${words.length} words · ${duration > 0 ? formatDurationMS(duration) : ''}`
                  : duration > 0 ? formatDurationMS(duration) : ''}
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
          <TrimToolbar
            trimMode={trimMode}
            onModeChange={setTrimMode}
            hasSelection={trimRange !== null}
            duration={duration}
            selectedStartSec={selectedStartSec}
            selectedEndSec={selectedEndSec}
            selectedDurationSec={selectedDurationSec}
            resultDurationSec={resultDurationSec}
            chunkADurationSec={chunkADurationSec}
            chunkBDurationSec={chunkBDurationSec}
            trimError={trimError}
            trimState={trimState}
            onClear={handleClear}
            onAction={handleAction}
          />

          <Waveform
            waveformRef={waveformRef}
            duration={duration}
            waveform={waveform}
            trimRange={trimRange}
            trimMode={trimMode}
            overCap={trimMode === 'keep' && resultDurationSec > VIDEO_EDIT_MAX_SEC + 0.05}
            capLineSec={capPointSec}
            markers={markers}
            frameBadges={frameBadges}
            playheadPercent={playheadPercent}
            onMouseDown={handleWaveformMouseDown}
            onStartHandleMouseDown={startHandleMouseDown}
            onEndHandleMouseDown={endHandleMouseDown}
          />

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

        <div className="shrink-0 border-t border-border/50 px-6 py-3">
          <ChatInput
            assetSlugs={assetSlugs}
            commands={contextCommands}
            onSend={handleSend}
            callTool={callTool}
            projectSlug={projectSlug}
            placeholder={placeholder}
          />
        </div>
      </div>
    </>
  );
}
