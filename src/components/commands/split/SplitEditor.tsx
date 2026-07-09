import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Eraser, Scissors, ChevronLeft, ChevronRight } from 'lucide-react';
import { cn } from '@/lib/utils';
import { ChatInput } from '@/components/ui/ChatInput';
import { CloseButton } from '@/components/ui/CloseButton';
import { CommandButton } from '@/components/commands/CommandButton';
import { useCommandDispatch } from '@/hooks/useCommandDispatch';
import type { UseMcpResult } from 'use-mcp/react';
import type { MediaItem } from '@/components/sidebar/types';
import type { ExecuteButtonState } from '@/components/commands/types';
import { formatSecondsBadge, isOverEditCap } from '@/lib/video-limits';
import { SplitFramePair } from './SplitFramePair';
import { SplitScrubber } from './SplitScrubber';
import { useLazySplitFrames } from './useLazySplitFrames';
import { useSceneMarkers } from './useSceneMarkers';
import { useSplitPoint } from './useSplitPoint';
import {
  DEFAULT_FPS,
  formatPrecise,
  frameDuration,
  MIN_CHUNK_SEC,
  parseTimestamp,
} from './utils';

const GENIE_MS = 380;

interface SplitEditorProps {
  open: boolean;
  assetId: string | null;
  initialAtSec?: number;
  item: MediaItem | null;
  onClose: () => void;
  assetSlugs: string[];
  callTool: UseMcpResult['callTool'];
  projectSlug: string | undefined;
}

export function SplitEditor({
  open,
  assetId,
  initialAtSec,
  item,
  onClose,
  assetSlugs,
  callTool,
  projectSlug,
}: SplitEditorProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [exiting, setExiting] = useState(false);
  const [execState, setExecState] = useState<ExecuteButtonState | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [overlapSec, setOverlapSec] = useState(0);

  // Reset transient UI when a new asset is opened.
  const sessionKey = open ? `${assetId ?? ''}|${initialAtSec ?? ''}` : '';
  const [prevSession, setPrevSession] = useState(sessionKey);
  if (prevSession !== sessionKey) {
    setPrevSession(sessionKey);
    setExiting(false);
    setError(null);
    setExecState(undefined);
    setOverlapSec(0);
  }

  const duration = item?.duration ?? 0;
  const fps = DEFAULT_FPS;
  const frameStep = frameDuration(fps);

  const {
    splitSec,
    setSplitSec,
    setSplitFromPct,
    nudgeFrames,
    resetToMid,
    clear,
  } = useSplitPoint({
    open: open && !exiting,
    duration,
    fps,
    initialSec: initialAtSec ?? null,
  });

  const markers = useSceneMarkers(open, assetId, projectSlug);

  const leftSec = useMemo(() => {
    if (splitSec === null) return null;
    return Math.max(0, splitSec - frameStep);
  }, [splitSec, frameStep]);

  const rightSec = splitSec;

  const halfOverlap = overlapSec / 2;
  const chunkADur = splitSec !== null ? splitSec + halfOverlap : 0;
  const chunkBDur = splitSec !== null && duration > 0
    ? duration - splitSec + halfOverlap
    : 0;

  const videoSrc = item?.filePath ?? '';
  const { leftUrl, rightUrl, seeking, videoRef } = useLazySplitFrames({
    open: open && !exiting,
    videoSrc,
    fps,
    leftSec,
    rightSec,
  });

  const requestClose = useCallback(() => {
    if (exiting) return;
    setExiting(true);
    window.setTimeout(() => {
      onClose();
    }, GENIE_MS);
  }, [exiting, onClose]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        e.preventDefault();
        requestClose();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open, requestClose]);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      if (!target) return;
      const tag = target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
          || tag === 'VIDEO' || tag === 'AUDIO' || tag === 'BUTTON' || tag === 'IMG') return;
      if (target.isContentEditable) return;
      if (target.closest('[data-radix-popper-content-wrapper]')) return;
      if (target.closest('[data-split-scrubber]')) return;
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

  const runSplit = useCallback(async () => {
    if (execState || !assetId || !projectSlug || splitSec === null || duration <= 0) return;
    if (chunkADur < MIN_CHUNK_SEC || chunkBDur < MIN_CHUNK_SEC) {
      setError(`Chunks too short (min ${MIN_CHUNK_SEC}s each). Move the split line away from the ends.`);
      return;
    }
    setError(null);
    setExecState('charging');
    await new Promise((r) => setTimeout(r, 350));
    setExecState('processing');
    try {
      const result = await callTool('split_video', {
        asset_id: assetId,
        project_slug: projectSlug,
        chunk_a_end: splitSec + halfOverlap,
        chunk_b_start: splitSec - halfOverlap,
      });
      if (result && 'isError' in result && result.isError) {
        const msg = Array.isArray(result.content) && result.content[0]?.text
          ? String(result.content[0].text)
          : 'split_video failed';
        setError(msg);
        setExecState(undefined);
        return;
      }
      setExecState('success');
      setTimeout(() => {
        setExecState(undefined);
        requestClose();
      }, 1000);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'split_video failed');
      setExecState(undefined);
    }
  }, [
    execState, assetId, projectSlug, splitSec, duration,
    chunkADur, chunkBDur, halfOverlap, callTool, requestClose,
  ]);

  const handleSend = async (message: string): Promise<boolean> => {
    const raw = message.trim();
    const cmd = raw.toLowerCase();
    if (cmd === '/close') { requestClose(); return true; }
    if (cmd === '/clear') { clear(); setOverlapSec(0); return true; }
    if (cmd === '/mid' || cmd === '/reset') { resetToMid(); return true; }
    if (cmd.startsWith('/goto')) {
      const arg = raw.slice(5).trim();
      const t = parseTimestamp(arg);
      if (t !== undefined) setSplitSec(t);
      return true;
    }
    if (cmd.startsWith('/frame')) {
      const arg = raw.slice(6).trim();
      const n = Number(arg.replace(/^\+/, ''));
      if (Number.isFinite(n) && n !== 0) nudgeFrames(n);
      else if (arg === '+' || arg === '') nudgeFrames(1);
      else if (arg === '-') nudgeFrames(-1);
      return true;
    }
    if (cmd.startsWith('/overlap')) {
      const arg = raw.slice(8).trim();
      const n = Number(arg);
      if (Number.isFinite(n) && n >= 0) {
        const max = splitSec !== null && duration > 0
          ? Math.max(0, Math.min(splitSec, duration - splitSec) * 2)
          : 0;
        setOverlapSec(Math.min(n, max));
      }
      return true;
    }
    if (cmd === '/split' || cmd === '/split here' || cmd === '/confirm' || cmd.startsWith('/split here')) {
      await runSplit();
      return true;
    }
    return contextDispatch(message);
  };

  const overCap = isOverEditCap(chunkADur) || isOverEditCap(chunkBDur);
  const hasSplit = splitSec !== null;
  const maxOverlap = splitSec !== null && duration > 0
    ? Math.max(0, Math.min(splitSec, duration - splitSec) * 2)
    : 0;

  if (!open && !exiting) return null;

  return (
    <>
      <div
        className={cn(
          'fixed inset-0 bg-black/80 backdrop-blur-sm z-[100] transition-opacity',
          exiting ? 'opacity-0' : 'opacity-100',
        )}
        style={{ transitionDuration: `${GENIE_MS}ms` }}
        onClick={requestClose}
      />
      <div
        ref={dialogRef}
        role="dialog"
        aria-label="Split video"
        className={cn(
          'fixed inset-0 z-[101] bg-zinc-950 flex flex-col split-genie',
          exiting ? 'split-genie-closed' : 'split-genie-open',
        )}
      >
        <video
          ref={videoRef}
          src={videoSrc || undefined}
          preload="auto"
          muted
          playsInline
          className="hidden"
          crossOrigin="anonymous"
        />

        <div className="h-12 shrink-0 flex items-center justify-between px-5 border-b border-zinc-700/60 bg-gradient-to-r from-zinc-900 via-zinc-900/95 to-zinc-950 relative">
          <span className="font-mono text-xs tracking-widest text-violet-400/80 uppercase">Split</span>
          <div className="absolute inset-x-0 flex justify-center pointer-events-none">
            <span className="font-mono text-xs tracking-widest text-zinc-400">
              {assetId ? `@${assetId}` : ''}
            </span>
          </div>
          <CloseButton onClick={requestClose} title="Close (ESC)" />
        </div>

        <SplitFramePair
          leftUrl={leftUrl}
          rightUrl={rightUrl}
          leftSec={leftSec}
          rightSec={rightSec}
          chunkADur={chunkADur}
          chunkBDur={chunkBDur}
          seeking={seeking}
        />

        <div className="shrink-0 px-6 py-3 flex flex-col gap-2 border-t border-zinc-800">
          <div className="grid grid-cols-[auto_1fr_auto] items-center gap-3">
            <div className="flex items-center gap-1">
              <button
                type="button"
                className="h-9 w-9 flex items-center justify-center rounded border border-zinc-700/70 text-zinc-400 hover:text-violet-300 hover:border-violet-500/40 hover:bg-violet-500/10"
                onClick={() => nudgeFrames(-1)}
                title="Previous frame (←)"
              >
                <ChevronLeft className="w-4 h-4" />
              </button>
              <button
                type="button"
                className="h-9 w-9 flex items-center justify-center rounded border border-zinc-700/70 text-zinc-400 hover:text-violet-300 hover:border-violet-500/40 hover:bg-violet-500/10"
                onClick={() => nudgeFrames(1)}
                title="Next frame (→)"
              >
                <ChevronRight className="w-4 h-4" />
              </button>
            </div>

            <div className={cn(
              'min-w-0 rounded border px-3 py-2 font-mono text-[11px]',
              overCap
                ? 'border-amber-400/50 bg-amber-500/10'
                : 'border-violet-500/30 bg-violet-500/8',
            )}>
              {hasSplit ? (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                  <span className="uppercase tracking-widest text-violet-300">Split</span>
                  <span className="text-zinc-300">{formatPrecise(splitSec!)}</span>
                  <label className="inline-flex items-center gap-1.5 text-zinc-400">
                    <span className="uppercase tracking-widest text-[10px]">overlap</span>
                    <input
                      type="number"
                      step={0.1}
                      min={0}
                      max={maxOverlap}
                      value={overlapSec.toFixed(2).replace(/\.?0+$/, '')}
                      onChange={(e) => {
                        const n = Number(e.target.value);
                        if (!Number.isFinite(n)) return;
                        setOverlapSec(Math.max(0, Math.min(maxOverlap, n)));
                      }}
                      className="w-14 h-6 px-1.5 rounded bg-black/40 border border-violet-400/40 text-violet-200 text-right font-mono text-[11px] focus:outline-none focus:border-violet-300/60"
                    />
                    <span className="text-[10px] text-zinc-500">s</span>
                  </label>
                  <span className="ml-auto flex items-center gap-2">
                    <Pill label="A" sec={chunkADur} warn={isOverEditCap(chunkADur)} />
                    <Pill label="B" sec={chunkBDur} warn={isOverEditCap(chunkBDur)} />
                  </span>
                </div>
              ) : (
                <span className="uppercase tracking-widest text-zinc-500">
                  Click the timeline to set the split point
                </span>
              )}
            </div>

            <div className="flex items-center gap-2">
              <CommandButton
                command="/clear"
                icon={<Eraser className="w-4 h-4" />}
                size="default"
                onClick={() => { clear(); setOverlapSec(0); }}
              />
              <CommandButton
                command="/split here"
                icon={<Scissors className="w-4 h-4" />}
                size="default"
                variant="video"
                state={execState ?? (hasSplit ? undefined : 'disabled')}
                disabledReason="Set a split point on the timeline first"
                onClick={() => { void runSplit(); }}
              />
            </div>
          </div>

          <SplitScrubber
            duration={duration}
            waveform={item?.waveform ?? []}
            splitSec={splitSec}
            markers={markers}
            onSetSplitPct={setSplitFromPct}
            onSetSplitSec={setSplitSec}
          />

          {error && (
            <div className="rounded border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-300 break-words whitespace-pre-wrap">
              {error}
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
            placeholder="drag the line or /frame +1 · /split here when perfect"
          />
        </div>
      </div>
    </>
  );
}

function Pill({ label, sec, warn }: { label: string; sec: number; warn: boolean }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[11px]',
        warn
          ? 'bg-amber-500/15 text-amber-300 border border-amber-400/50'
          : 'bg-zinc-800 text-zinc-300 border border-zinc-600/50',
      )}
    >
      <span className="text-zinc-500 font-bold">{label}</span>
      {warn && <span>⚠</span>}
      <span>{formatSecondsBadge(sec)}</span>
    </span>
  );
}
