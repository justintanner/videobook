import { useCallback, useMemo, useState, type ReactNode } from 'react'
import { Scissors, Eraser, Loader2, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { ChatInput } from '@/components/ui/ChatInput'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogCloseButton,
} from '@/components/ui/dialog'
import { DISABLED_STATE, FOCUS_RING_BUTTON, LOADING_STATE } from '@/components/ui/interaction-states'
import { useCommandDispatch } from '@/hooks/useCommandDispatch'
import type { UseMcpResult } from 'use-mcp/react'
import type { MediaItem } from '@/components/sidebar/types'
import type { ExecuteButtonState } from '@/components/commands/types'
import { SplitFramePair } from './SplitFramePair'
import { SplitScrubber } from './SplitScrubber'
import { BoundaryPlayer } from './BoundaryPlayer'
import { TranscriptPanel } from './TranscriptPanel'
import { EvenModePanel } from './EvenModePanel'
import { useLazySplitFrames } from './useLazySplitFrames'
import { useSceneMarkers } from './useSceneMarkers'
import { useSplitPoint } from './useSplitPoint'
import { useTranscript } from './useTranscript'
import { useBoundaryPlayer } from './useBoundaryPlayer'
import {
  DEFAULT_FPS,
  formatPrecise,
  frameDuration,
  MIN_CHUNK_SEC,
  parseTimestamp,
  planIntervalSplit,
} from './utils'
import type { IntervalSeconds, SplitMode } from './types'

interface SplitEditorProps {
  open: boolean
  assetId: string | null
  initialAtSec?: number
  item: MediaItem | null
  onClose: () => void
  onComplete?: () => void
  assetSlugs: string[]
  callTool: UseMcpResult['callTool']
  projectSlug: string | undefined
}

const DEFAULT_INTERVAL: IntervalSeconds = 10

export function SplitEditor({
  open,
  assetId,
  initialAtSec,
  item,
  onClose,
  onComplete,
  assetSlugs,
  callTool,
  projectSlug,
}: SplitEditorProps) {
  const initialMode: SplitMode = initialAtSec != null ? 'manual' : 'even'
  const [mode, setMode] = useState<SplitMode>(initialMode)
  const [interval, setIntervalSec] = useState<IntervalSeconds>(DEFAULT_INTERVAL)
  const [execState, setExecState] = useState<ExecuteButtonState | undefined>(undefined)
  const [error, setError] = useState<string | null>(null)
  const [activeBoundaryIndex, setActiveBoundaryIndex] = useState(0)

  const sessionKey = open ? `${assetId ?? ''}|${initialAtSec ?? ''}` : ''
  const [prevSession, setPrevSession] = useState(sessionKey)
  if (prevSession !== sessionKey) {
    setPrevSession(sessionKey)
    setMode(initialAtSec != null ? 'manual' : 'even')
    setIntervalSec(DEFAULT_INTERVAL)
    setError(null)
    setExecState(undefined)
    setActiveBoundaryIndex(0)
  }

  const duration = item?.duration ?? 0
  const fps = DEFAULT_FPS
  const frameStep = frameDuration(fps)

  const {
    splitSec,
    setSplitSec,
    setSplitFromPct,
    nudgeFrames,
    resetToMid,
    clear,
  } = useSplitPoint({
    open: open && mode === 'manual',
    duration,
    fps,
    initialSec: initialAtSec ?? null,
  })

  const markers = useSceneMarkers(open, assetId, projectSlug)

  const { state: transcriptState, fetchTranscript } = useTranscript()

  const videoSrc = item?.filePath ?? ''

  const intervalPlan = useMemo(() => {
    if (mode !== 'even' || duration <= 0) return null
    return planIntervalSplit(duration, interval)
  }, [mode, duration, interval])

  const evenBoundaries = intervalPlan?.boundaries ?? []
  const evenClipDurations = intervalPlan?.clipDurations ?? []
  const evenClipCount = intervalPlan?.clipCount ?? 0
  const evenDisabled = intervalPlan?.disabled ?? true
  const evenDisabledReason = intervalPlan?.disabledReason ?? null
  const evenTargets = useMemo(() => intervalPlan?.targets ?? [], [intervalPlan])

  const activeBoundary = mode === 'even'
    ? (evenBoundaries[activeBoundaryIndex] ?? null)
    : splitSec

  const { videoRef: boundaryVideoRef, playing, togglePlay, currentTime } = useBoundaryPlayer(
    videoSrc,
    activeBoundary,
    duration,
  )

  const loadTranscript = useCallback(() => {
    if (assetId && projectSlug) {
      void fetchTranscript(assetId, projectSlug, callTool)
    }
  }, [assetId, projectSlug, callTool, fetchTranscript])

  const handleOpenChange = useCallback((newOpen: boolean) => {
    if (!newOpen) onClose()
  }, [onClose])

  const leftSec = useMemo(() => {
    if (activeBoundary === null) return null
    return Math.max(0, activeBoundary - frameStep)
  }, [activeBoundary, frameStep])

  const rightSec = activeBoundary

  const { leftUrl, rightUrl, seeking, videoRef: frameVideoRef } = useLazySplitFrames({
    open: open && activeBoundary !== null,
    videoSrc,
    fps,
    leftSec,
    rightSec,
  })

  const chunkADur = splitSec !== null ? splitSec : 0
  const chunkBDur = splitSec !== null && duration > 0 ? duration - splitSec : 0
  const previewLeftDuration = mode === 'even'
    ? (evenClipDurations[activeBoundaryIndex] ?? 0)
    : chunkADur
  const previewRightDuration = mode === 'even'
    ? (evenClipDurations[activeBoundaryIndex + 1] ?? 0)
    : chunkBDur

  const finishSuccess = useCallback(() => {
    setExecState('success')
    onComplete?.()
    setTimeout(() => {
      setExecState(undefined)
      onClose()
    }, 1000)
  }, [onComplete, onClose])

  const runManualSplit = useCallback(async () => {
    if (execState || !assetId || !projectSlug || splitSec === null || duration <= 0) return
    if (chunkADur < MIN_CHUNK_SEC || chunkBDur < MIN_CHUNK_SEC) {
      setError(`Chunks too short (min ${MIN_CHUNK_SEC}s each). Move the split line away from the ends.`)
      return
    }
    setError(null)
    setExecState('charging')
    await new Promise((r) => setTimeout(r, 350))
    setExecState('processing')
    try {
      const result = await callTool('split_video', {
        asset_id: assetId,
        project_slug: projectSlug,
        chunk_a_end: splitSec,
        chunk_b_start: splitSec,
      })
      if (result && 'isError' in result && result.isError) {
        const msg = Array.isArray(result.content) && result.content[0]?.text
          ? String(result.content[0].text)
          : 'split_video failed'
        setError(msg)
        setExecState(undefined)
        return
      }
      finishSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'split_video failed')
      setExecState(undefined)
    }
  }, [execState, assetId, projectSlug, splitSec, duration, chunkADur, chunkBDur, callTool, finishSuccess])

  const runEvenSplit = useCallback(async () => {
    if (execState || !assetId || !projectSlug || evenDisabled || evenTargets.length === 0) return
    setError(null)
    setExecState('charging')
    await new Promise((r) => setTimeout(r, 350))
    setExecState('processing')
    try {
      const result = await callTool('even_split', {
        asset_id: assetId,
        project_slug: projectSlug,
        target_secs: evenTargets,
      })
      if (result && 'isError' in result && result.isError) {
        const msg = Array.isArray(result.content) && result.content[0]?.text
          ? String(result.content[0].text)
          : 'even_split failed'
        setError(msg)
        setExecState(undefined)
        return
      }
      finishSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'even_split failed')
      setExecState(undefined)
    }
  }, [execState, assetId, projectSlug, evenDisabled, evenTargets, callTool, finishSuccess])

  const { dispatch: contextDispatch, commands: contextCommands } = useCommandDispatch()

  const handleSend = async (message: string): Promise<boolean> => {
    const raw = message.trim()
    const cmd = raw.toLowerCase()
    if (cmd === '/close') { onClose(); return true }
    if (cmd === '/clear') {
      clear()
      setError(null)
      return true
    }
    if (cmd === '/mid' || cmd === '/reset') { resetToMid(); return true }
    if (cmd.startsWith('/every')) {
      const arg = raw.slice(6).trim()
      const n = Number(arg)
      if (n === 5 || n === 10 || n === 15) {
        setIntervalSec(n as IntervalSeconds)
        setMode('even')
        setActiveBoundaryIndex(0)
      }
      return true
    }
    if (cmd === '/manual') { setMode('manual'); return true }
    if (cmd.startsWith('/goto')) {
      const arg = raw.slice(5).trim()
      const t = parseTimestamp(arg)
      if (t !== undefined) {
        setMode('manual')
        setSplitSec(t)
      }
      return true
    }
    if (cmd.startsWith('/frame')) {
      setMode('manual')
      const arg = raw.slice(6).trim()
      const n = Number(arg.replace(/^\+/, ''))
      if (Number.isFinite(n) && n !== 0) nudgeFrames(n)
      else if (arg === '+' || arg === '') nudgeFrames(1)
      else if (arg === '-') nudgeFrames(-1)
      return true
    }
    if (cmd === '/split here' || cmd === '/split') {
      if (mode === 'manual') {
        await runManualSplit()
      } else {
        await runEvenSplit()
      }
      return true
    }
    return contextDispatch(message)
  }

  const hasSplit = splitSec !== null
  const isBusy = execState === 'charging' || execState === 'processing' || execState === 'success'

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="w-[96vw] max-w-none h-[94vh] max-h-none"
        aria-label="Split video"
        onOpenAutoFocus={() => { loadTranscript() }}
      >
        <video
          ref={frameVideoRef}
          src={videoSrc || undefined}
          preload="auto"
          muted
          playsInline
          className="hidden"
          crossOrigin="anonymous"
        />
        <DialogDescription className="sr-only">Split video editor</DialogDescription>
        <DialogHeader>
          <DialogTitle>Split</DialogTitle>
          <span className="font-mono text-xs text-neutral-400">
            {assetId ? `@${assetId}` : ''}
          </span>
          <DialogCloseButton onClick={onClose} title="Close (ESC)" />
        </DialogHeader>

        <div className="flex-1 min-h-0 flex flex-col gap-2 p-4 overflow-hidden">
          <ModeTabs mode={mode} onModeChange={setMode} />

          <div className="flex-1 min-h-[280px] flex flex-col gap-1.5">
            <div className="shrink-0 flex items-center justify-between">
              <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-neutral-500">
                Boundary frames
              </span>
              {activeBoundary !== null && (
                <span className="font-mono text-[11px] text-neutral-400">
                  Cut at {formatPrecise(activeBoundary)}
                </span>
              )}
            </div>
            <SplitFramePair
              leftUrl={leftUrl}
              rightUrl={rightUrl}
              leftSec={leftSec}
              rightSec={rightSec}
              chunkADur={previewLeftDuration}
              chunkBDur={previewRightDuration}
              seeking={seeking}
              overlay={(
                <BoundaryPlayer
                  videoRef={boundaryVideoRef}
                  videoSrc={videoSrc}
                  boundarySec={activeBoundary}
                  duration={duration}
                  playing={playing}
                  currentTime={currentTime}
                  onTogglePlay={togglePlay}
                />
              )}
            />
          </div>

          <div className="shrink-0 h-[68px] grid grid-cols-[110px_1fr] overflow-hidden rounded-md border border-neutral-700/50 bg-neutral-800/30">
            <div className="flex items-center px-3 border-r border-neutral-700/40">
              <span className="font-mono text-[10px] tracking-[0.2em] uppercase text-neutral-500">
                Transcript
              </span>
            </div>
            <div className="min-w-0 overflow-hidden">
              <TranscriptPanel state={transcriptState} currentTime={currentTime} compact />
            </div>
          </div>

          {mode === 'even' ? (
            <div className="shrink-0 flex flex-col gap-2">
              <EvenModePanel
                duration={duration}
                interval={interval}
                onIntervalChange={(v) => { setIntervalSec(v); setActiveBoundaryIndex(0) }}
                boundaries={evenBoundaries}
                clipDurations={evenClipDurations}
                clipCount={evenClipCount}
                disabled={evenDisabled}
                disabledReason={evenDisabledReason}
                activeBoundaryIndex={activeBoundaryIndex}
                onActiveBoundaryChange={setActiveBoundaryIndex}
              />
              <div className="flex items-center justify-end gap-2">
                <ActionButton
                  label={evenClipCount > 0 ? `Split into ${evenClipCount} clips` : 'Split'}
                  icon={<Scissors className="w-4 h-4" />}
                  state={execState ?? (evenDisabled ? 'disabled' : undefined)}
                  disabledReason={evenDisabledReason ?? 'Cannot split at this interval'}
                  onClick={() => { void runEvenSplit() }}
                />
              </div>
            </div>
          ) : (
            <div className="shrink-0 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <div className={cn(
                  'min-w-0 flex-1 rounded border px-3 py-2 font-mono text-[11px]',
                  'border-neutral-600/40 bg-neutral-700/20',
                )}>
                  {hasSplit ? (
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                      <span className="uppercase tracking-widest text-neutral-400">Split at</span>
                      <span className="text-neutral-200">{formatPrecise(splitSec!)}</span>
                      <span className="ml-auto text-neutral-500">
                        A: {chunkADur.toFixed(1)}s · B: {chunkBDur.toFixed(1)}s
                      </span>
                    </div>
                  ) : (
                    <span className="uppercase tracking-widest text-neutral-600">
                      Click the timeline to set the split point
                    </span>
                  )}
                </div>
                <ActionButton
                  label="Clear"
                  icon={<Eraser className="w-4 h-4" />}
                  variant="neutral"
                  disabled={isBusy || !hasSplit}
                  onClick={() => { clear(); setError(null) }}
                />
                <ActionButton
                  label="Split here"
                  icon={<Scissors className="w-4 h-4" />}
                  state={execState ?? (hasSplit ? undefined : 'disabled')}
                  disabledReason="Set a split point on the timeline first"
                  onClick={() => { void runManualSplit() }}
                />
              </div>
              <SplitScrubber
                duration={duration}
                waveform={item?.waveform ?? []}
                splitSec={splitSec}
                markers={markers}
                onSetSplitPct={setSplitFromPct}
                onSetSplitSec={setSplitSec}
              />
            </div>
          )}

          {error && (
            <div className="shrink-0 rounded border border-red-500/40 bg-red-500/10 px-3 py-2 font-mono text-[11px] text-red-300 break-words whitespace-pre-wrap">
              {error}
            </div>
          )}
        </div>

        <div className="shrink-0 border-t border-neutral-700/50 px-4 py-2">
          <ChatInput
            assetSlugs={assetSlugs}
            commands={contextCommands}
            onSend={handleSend}
            callTool={callTool}
            projectSlug={projectSlug}
            placeholder={mode === 'even'
              ? '/every 5|10|15 · /manual · /split'
              : 'drag the line or /frame +1 · /split here when perfect'}
          />
        </div>
      </DialogContent>
    </Dialog>
  )
}

function ModeTabs({ mode, onModeChange }: { mode: SplitMode; onModeChange: (m: SplitMode) => void }) {
  return (
    <div className="shrink-0 flex gap-1" role="tablist" aria-label="Split mode">
      {(['even', 'manual'] as const).map((m) => (
        <button
          key={m}
          type="button"
          role="tab"
          aria-selected={mode === m}
          onClick={() => onModeChange(m)}
          className={cn(
            'px-4 py-1.5 rounded font-mono text-[11px] tracking-wide transition-colors',
            'focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-neutral-400',
            mode === m
              ? 'bg-neutral-100 text-neutral-900'
              : 'bg-neutral-800/50 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-700/50',
          )}
        >
          {m === 'even' ? 'Even cuts' : 'Manual'}
        </button>
      ))}
    </div>
  )
}

function ActionButton({
  label,
  icon,
  state,
  disabledReason,
  disabled,
  variant = 'primary',
  onClick,
}: {
  label: string
  icon: ReactNode
  state?: ExecuteButtonState
  disabledReason?: string
  disabled?: boolean
  variant?: 'primary' | 'neutral'
  onClick: () => void
}) {
  const isDisabled = disabled || state === 'disabled'
  const isLoading = state === 'charging' || state === 'processing'
  const isSuccess = state === 'success'
  const blocked = isDisabled || isLoading || isSuccess

  let displayIcon = icon
  if (isLoading) displayIcon = <Loader2 className="w-4 h-4 animate-spin" />
  else if (isSuccess) displayIcon = <CheckCircle2 className="w-4 h-4" />

  const displayLabel = isLoading
    ? (state === 'charging' ? 'Preparing…' : 'Splitting…')
    : isSuccess
      ? 'Done'
      : label

  const button = (
    <button
      type="button"
      disabled={blocked}
      title={isDisabled && disabledReason ? disabledReason : undefined}
      onClick={onClick}
      className={cn(
        'inline-flex items-center gap-2 h-9 px-3 rounded font-mono text-[11px] tracking-wide',
        'border transition-colors',
        FOCUS_RING_BUTTON,
        'focus-visible:ring-neutral-400/60',
        DISABLED_STATE,
        isLoading && LOADING_STATE,
        variant === 'primary' && !blocked && 'bg-cyan-600/80 border-cyan-500/60 text-white hover:bg-cyan-500/90',
        variant === 'primary' && blocked && 'bg-cyan-900/40 border-cyan-800/40 text-cyan-200/50',
        variant === 'neutral' && !blocked && 'bg-neutral-800/60 border-neutral-600/50 text-neutral-200 hover:bg-neutral-700/60 hover:border-neutral-500',
        variant === 'neutral' && blocked && 'bg-neutral-900/40 border-neutral-700/40 text-neutral-500',
        isSuccess && 'bg-emerald-700/50 border-emerald-500/40 text-emerald-100',
      )}
    >
      {displayIcon}
      <span>{displayLabel}</span>
    </button>
  )

  if (isDisabled && disabledReason) {
    return (
      <span className="inline-flex" title={disabledReason}>
        {button}
      </span>
    )
  }
  return button
}
