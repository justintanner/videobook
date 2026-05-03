import { Check, Eraser, Scissors, Trash2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import { CommandButton } from '@/components/commands/CommandButton';
import { formatSecondsBadge, isOverEditCap, VIDEO_EDIT_MAX_SEC } from '@/lib/video-limits';
import type { ExecuteButtonState } from '@/components/commands/types';
import type { TrimMode } from './types';
import { getModeClasses } from './mode-classes';

interface TrimToolbarProps {
  trimMode: TrimMode;
  onModeChange: (mode: TrimMode) => void;

  hasActionable: boolean;
  duration: number;
  selectedStartSec: number;
  selectedEndSec: number;
  selectedDurationSec: number;
  resultDurationSec: number;

  // Split-mode state.
  splitPointSec: number | null;
  overlapSec: number;
  onOverlapChange: (sec: number) => void;
  chunkADurationSec: number;
  chunkBDurationSec: number;

  trimError: string | null;
  trimState: ExecuteButtonState | undefined;
  onClear: () => void;
  onAction: () => void;
}

export function TrimToolbar({
  trimMode,
  onModeChange,
  hasActionable,
  duration,
  selectedStartSec,
  selectedEndSec,
  selectedDurationSec,
  resultDurationSec,
  splitPointSec,
  overlapSec,
  onOverlapChange,
  chunkADurationSec,
  chunkBDurationSec,
  trimError,
  trimState,
  onClear,
  onAction,
}: TrimToolbarProps) {
  const overCap =
    trimMode === 'split'
      ? isOverEditCap(chunkADurationSec) || isOverEditCap(chunkBDurationSec)
      : isOverEditCap(resultDurationSec);
  const modeClasses = getModeClasses(trimMode, overCap);

  const actionCommand =
    trimMode === 'keep' ? '/keep selection' :
    trimMode === 'remove' ? '/remove selection' :
    '/split here';
  const actionIcon =
    trimMode === 'keep' ? <Check className="w-4 h-4" /> :
    trimMode === 'remove' ? <Trash2 className="w-4 h-4" /> :
    <Scissors className="w-4 h-4" />;

  return (
    <div className="grid grid-cols-[auto_1fr_auto] items-stretch gap-3">
      {/* Mode tiles */}
      <div className="flex rounded border border-zinc-700/70 bg-black/40 overflow-hidden">
        <ModeTile
          active={trimMode === 'keep'}
          icon={<Check className="w-4 h-4" />}
          label="Keep"
          activeBg="bg-emerald-500/18"
          activeText="text-emerald-300"
          onClick={() => onModeChange('keep')}
        />
        <ModeTile
          active={trimMode === 'remove'}
          icon={<Trash2 className="w-4 h-4" />}
          label="Remove"
          activeBg="bg-red-500/18"
          activeText="text-red-300"
          onClick={() => onModeChange('remove')}
          borderL
        />
        <ModeTile
          active={trimMode === 'split'}
          icon={<Scissors className="w-4 h-4" />}
          label="Split"
          activeBg="bg-violet-500/18"
          activeText="text-violet-300"
          onClick={() => onModeChange('split')}
          borderL
        />
      </div>

      {/* Summary panel */}
      <div className={cn('min-w-0 rounded border px-3 py-2 font-mono', modeClasses.border, modeClasses.soft)}>
        {trimMode === 'split' ? (
          <SplitSummary
            splitPointSec={splitPointSec}
            overlapSec={overlapSec}
            onOverlapChange={onOverlapChange}
            duration={duration}
            chunkA={chunkADurationSec}
            chunkB={chunkBDurationSec}
          />
        ) : hasActionable && duration > 0 ? (
          <KeepRemoveSummary
            mode={trimMode}
            startSec={selectedStartSec}
            endSec={selectedEndSec}
            selectedSec={selectedDurationSec}
            resultSec={resultDurationSec}
            overCap={overCap}
          />
        ) : (
          <div className="text-[11px] uppercase tracking-widest text-zinc-500">
            Drag across the waveform to select a range
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2">
        <CommandButton command="/clear" icon={<Eraser className="w-4 h-4" />} size="default" onClick={onClear} />
        {trimError && (
          <span className="text-[11px] font-mono text-red-400 truncate max-w-[300px]">{trimError}</span>
        )}
        <CommandButton
          command={actionCommand}
          icon={actionIcon}
          size="default"
          variant={modeClasses.buttonVariant}
          state={trimState ?? (hasActionable ? undefined : 'disabled')}
          disabledReason={
            trimMode === 'split'
              ? 'Click on the waveform to set a split point'
              : 'Drag on the waveform to select a trim range'
          }
          onClick={onAction}
        />
      </div>
    </div>
  );
}

interface ModeTileProps {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  activeBg: string;
  activeText: string;
  onClick: () => void;
  borderL?: boolean;
}

function ModeTile({ active, icon, label, activeBg, activeText, onClick, borderL }: ModeTileProps) {
  return (
    <button
      type="button"
      className={cn(
        'h-10 px-3 flex items-center gap-2 font-mono text-[11px] uppercase tracking-wider transition-colors',
        borderL && 'border-l border-zinc-700/70',
        active ? cn(activeBg, activeText) : 'text-zinc-500 hover:text-zinc-300 hover:bg-zinc-900',
      )}
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

interface KeepRemoveSummaryProps {
  mode: 'keep' | 'remove';
  startSec: number;
  endSec: number;
  selectedSec: number;
  resultSec: number;
  overCap: boolean;
}

function KeepRemoveSummary({ mode, startSec, endSec, selectedSec, resultSec, overCap }: KeepRemoveSummaryProps) {
  const modeClasses = getModeClasses(mode, false);
  return (
    <div className="grid grid-cols-[auto_auto_1fr_auto] items-center gap-3 text-[11px]">
      <span className={cn('uppercase tracking-widest', modeClasses.text)}>
        {mode === 'keep' ? 'Keep' : 'Remove'}
      </span>
      <span className="text-zinc-500">
        {formatSecondsBadge(startSec)} → {formatSecondsBadge(endSec)}
      </span>
      <span className="text-zinc-600 truncate">
        selected {formatSecondsBadge(selectedSec)}
      </span>
      <ResultPill sec={resultSec} overCap={overCap} />
    </div>
  );
}

interface SplitSummaryProps {
  splitPointSec: number | null;
  overlapSec: number;
  onOverlapChange: (sec: number) => void;
  duration: number;
  chunkA: number;
  chunkB: number;
}

function SplitSummary({ splitPointSec, overlapSec, onOverlapChange, duration, chunkA, chunkB }: SplitSummaryProps) {
  if (splitPointSec === null) {
    return (
      <div className="text-[11px] uppercase tracking-widest text-zinc-500">
        Click on the waveform to set the split point
      </div>
    );
  }
  return (
    <div className="grid grid-cols-[auto_auto_auto_1fr_auto_auto] items-center gap-3 text-[11px]">
      <span className="uppercase tracking-widest text-violet-300">Split</span>
      <span className="text-zinc-400">at {formatSecondsBadge(splitPointSec)}</span>
      <OverlapInput value={overlapSec} max={Math.max(0, Math.min(splitPointSec, duration - splitPointSec) * 2)} onChange={onOverlapChange} />
      <span />
      <ResultPill sec={chunkA} overCap={isOverEditCap(chunkA)} prefix="A" />
      <ResultPill sec={chunkB} overCap={isOverEditCap(chunkB)} prefix="B" />
    </div>
  );
}

interface OverlapInputProps {
  value: number;
  max: number;
  onChange: (sec: number) => void;
}

function OverlapInput({ value, max, onChange }: OverlapInputProps) {
  return (
    <label className="inline-flex items-center gap-1.5 text-zinc-400">
      <span className="uppercase tracking-widest text-[10px]">overlap</span>
      <input
        type="number"
        step={0.1}
        min={0}
        max={max}
        value={value.toFixed(2).replace(/\.?0+$/, '')}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          onChange(Math.max(0, Math.min(max, n)));
        }}
        className="w-14 h-6 px-1.5 rounded bg-black/40 border border-violet-400/40 text-violet-200 text-right font-mono text-[11px] focus:outline-none focus:border-violet-300/60"
      />
      <span className="text-[10px] text-zinc-500">s</span>
    </label>
  );
}

function ResultPill({ sec, overCap, prefix }: { sec: number; overCap: boolean; prefix?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 px-2 py-0.5 rounded font-mono text-[11px]',
        overCap
          ? 'bg-amber-500/15 text-amber-300 border border-amber-400/50'
          : 'bg-emerald-500/10 text-emerald-300/90 border border-emerald-400/30',
      )}
      title={overCap ? `Over the ${VIDEO_EDIT_MAX_SEC}s video-edit cap` : undefined}
    >
      {prefix && <span className="text-zinc-400 font-bold">{prefix}</span>}
      {overCap && <span>⚠</span>}
      <span>{formatSecondsBadge(sec)}</span>
    </span>
  );
}
