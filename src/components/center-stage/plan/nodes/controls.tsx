// Compact in-node controls — a segmented option toggle and a Run button. Shared
// by SwapGenNode and SceneVideoNode. nodrag/nopan stop React Flow from hijacking
// clicks/drags on interactive elements.
import { Loader2, Play } from 'lucide-react';
import { cn } from '@/lib/utils';
import { FOCUS_RING_BUTTON } from '@/components/ui/interaction-states';

export function Segmented<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: ReadonlyArray<{ value: T; label: string }>;
  value: T;
  onChange: (next: T) => void;
  ariaLabel?: string;
}) {
  return (
    <div className="nodrag inline-flex rounded border border-zinc-700/70 overflow-hidden" role="group" aria-label={ariaLabel}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            className={cn(
              'px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wide transition-colors',
              active ? 'bg-emerald-500/25 text-emerald-200' : 'bg-black/40 text-zinc-400 hover:text-zinc-200',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function RunButton({
  onClick,
  running,
  disabled,
  label = 'Run',
  title,
  size = 'sm',
}: {
  onClick: () => void;
  running?: boolean;
  disabled?: boolean;
  label?: string;
  title?: string;
  size?: 'sm' | 'lg';
}) {
  const lg = size === 'lg';
  const iconCls = lg ? 'w-4 h-4' : 'w-3 h-3';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || running}
      title={title}
      className={cn(
        'nodrag flex items-center rounded font-mono font-bold uppercase tracking-wider',
        lg ? 'h-9 px-3.5 gap-1.5 text-xs' : 'h-6 px-2 gap-1 text-[10px]',
        'text-emerald-200 bg-emerald-500/15 hover:bg-emerald-500/25',
        'border border-emerald-500/40 hover:border-emerald-500/70 transition-colors',
        'disabled:opacity-40 disabled:cursor-not-allowed',
        FOCUS_RING_BUTTON,
      )}
    >
      {running ? <Loader2 className={cn(iconCls, 'animate-spin')} /> : <Play className={iconCls} />}
      {running ? '…' : label}
    </button>
  );
}
