import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ExecuteButtonState } from './types';

const sizes = {
  sm: {
    button: 'h-5 border border-primary/25 text-[10px]',
    chevronPad: 'px-1',
    promptPad: 'px-1.5 gap-1',
    iconPad: 'px-1',
    text: 'text-[10px] tracking-wider',
    chevron: 'text-xs',
    cursor: 'h-2',
    iconSize: 'w-3 h-3',
    dot: 'w-1 h-1',
    scanWidth: 'w-6',
  },
  default: {
    button: 'h-8 border border-primary/25',
    chevronPad: 'px-2',
    promptPad: 'px-2.5 gap-1.5',
    iconPad: 'px-2',
    text: 'text-xs tracking-widest',
    chevron: 'text-sm',
    cursor: 'h-3',
    iconSize: 'w-5 h-5',
    dot: 'w-1.5 h-1.5',
    scanWidth: 'w-12',
  },
  lg: {
    button: 'h-12 border-2 border-cyan-400 bg-cyan-500/20 text-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.3)]',
    chevronPad: 'px-3',
    promptPad: 'px-4 gap-2',
    iconPad: 'px-3',
    text: 'text-sm tracking-[0.2em]',
    chevron: 'text-xl font-bold',
    cursor: 'h-4',
    iconSize: 'w-5 h-5',
    dot: 'w-1.5 h-1.5',
    scanWidth: 'w-12',
  },
} as const;

const stateCommands: Record<string, Record<ExecuteButtonState, string | null>> = {
  default: {
    disabled: null,
    ready: null,
    charging: '/charging...',
    submitting: '/initializing...',
    queued: '/in-queue...',
    processing: '/generating...',
    success: '/complete',
  },
  lg: {
    disabled: null,
    ready: null,
    charging: null,
    submitting: null,
    queued: null,
    processing: 'generating',
    success: 'complete',
  },
  sm: {
    disabled: null,
    ready: null,
    charging: null,
    submitting: null,
    queued: null,
    processing: null,
    success: null,
  },
};

const variants = {
  default: {
    bg: 'bg-cyan-500/10',
    shadow: 'rgba(34,211,238,0.5)',
    chevron: 'text-primary/40 group-hover:text-primary/50',
    chevronDown: 'text-primary/40 group-hover:text-primary/60',
    cursorBg: 'bg-primary/40',
    promptBg: 'bg-black/40 shadow-[inset_0_0_10px_rgba(0,255,255,0.05)]',
    promptHover: 'group-hover:bg-black/60 group-hover:shadow-[inset_0_0_10px_rgba(0,255,255,0.12)]',
    text: 'text-primary/70 group-hover:text-primary/90',
    icon: 'text-primary/80 group-hover:text-primary',
  },
  violet: {
    bg: 'bg-violet-500/20 border-violet-500/30',
    shadow: 'rgba(139,92,246,0.5)',
    chevron: 'text-violet-400/40 group-hover:text-violet-400/50',
    chevronDown: 'text-violet-400/40 group-hover:text-violet-400/60',
    cursorBg: 'bg-violet-400/40',
    promptBg: 'bg-black/40 shadow-[inset_0_0_10px_rgba(139,92,246,0.05)]',
    promptHover: 'group-hover:bg-black/60 group-hover:shadow-[inset_0_0_10px_rgba(139,92,246,0.12)]',
    text: 'text-violet-400/70 group-hover:text-violet-400/90',
    icon: 'text-violet-400/80 group-hover:text-violet-400',
  },
} as const;

interface CommandButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  command: string;
  icon: ReactNode;
  chevron?: 'right' | 'down';
  size?: 'sm' | 'default' | 'lg';
  variant?: keyof typeof variants;
  state?: ExecuteButtonState;
  disabledReason?: string;
  className?: string;
}

export function CommandButton({ command, icon, chevron = 'right', size = 'default', variant = 'default', state, disabledReason, className, ...props }: CommandButtonProps) {
  const s = sizes[size];
  const v = variants[variant];
  const isDisabled = state === 'disabled';
  const isLoading = state != null && ['charging', 'submitting', 'queued', 'processing'].includes(state);
  const isSuccess = state === 'success';
  const displayCommand = state ? (stateCommands[size][state] ?? command) : command;

  let displayIcon = icon;
  if (isLoading) displayIcon = <Loader2 className={cn(s.iconSize, 'animate-spin')} />;
  else if (isSuccess) displayIcon = <CheckCircle2 className={s.iconSize} />;

  const button = (
    <button
      tabIndex={-1}
      disabled={isDisabled || isLoading || isSuccess || props.disabled}
      className={cn(
        'group flex items-center gap-0 rounded overflow-hidden relative',
        s.button,
        v.bg,
        'transition-all duration-300 cursor-pointer',
        // State color overrides (after size classes so twMerge picks them)
        state && isDisabled && 'bg-zinc-800/30 text-zinc-600 border-zinc-700/50 shadow-none cursor-not-allowed',
        state && isLoading && 'opacity-80 cursor-wait',
        state && isSuccess && 'bg-green-500/20 text-green-400 border-green-500/50 shadow-[0_0_20px_rgba(34,197,94,0.5)]',
        // Hover effects
        !isDisabled && !isLoading && !isSuccess && 'hover:border-primary/40',
        state && !isDisabled && !isLoading && !isSuccess && 'hover:scale-[1.02] active:scale-[0.98]',
        !state && size === 'lg' && 'hover:shadow-[0_0_25px_rgba(34,211,238,0.5)]',
        'focus-visible:ring-2 focus-visible:ring-cyan-400/80 focus-visible:ring-offset-1 focus-visible:ring-offset-black focus-visible:outline-none',
        className
      )}
      {...props}
    >
      {/* Charging gradient sweep */}
      {state === 'charging' && (
        <div
          className="absolute inset-0 pointer-events-none z-0"
          style={{
            background: `linear-gradient(90deg, transparent, ${v.shadow}, transparent)`,
            backgroundSize: '200% 100%',
            animation: 'showcase-charge 1s linear infinite',
          }}
        />
      )}

      {/* Processing scan line */}
      {state === 'processing' && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
          <div
            className={cn('absolute inset-y-0', s.scanWidth)}
            style={{
              background: `linear-gradient(90deg, transparent, ${v.shadow}, transparent)`,
              animation: 'showcase-scan 2s linear infinite',
            }}
          />
        </div>
      )}

      {/* Success flash */}
      {isSuccess && <div className="absolute inset-0 bg-green-500/30 animate-[showcase-success_0.5s_ease-out] pointer-events-none z-0" />}

      {/* Chevron zone */}
      <div className={cn(
        'relative z-10 flex items-center justify-center h-full transition-colors',
        s.chevronPad,
        isDisabled
          ? 'text-zinc-600'
          : chevron === 'down'
            ? v.chevronDown
            : v.chevron
      )}>
        {chevron === 'right' && !state && (
          <span
            className={cn(
              'absolute w-px',
              v.cursorBg,
              s.cursor,
              'opacity-0 group-hover:opacity-100 transition-opacity',
              'group-hover:animate-[cursor-blink_1s_step-end_infinite]'
            )}
          />
        )}
        <span className={cn(
          'font-mono select-none transition-all',
          s.chevron,
          chevron === 'down' && !isDisabled && '-translate-y-1 group-hover:animate-pulse',
          chevron === 'right' && !state && 'group-hover:opacity-0'
        )}>
          {chevron === 'down' ? '\u2304' : '\u203A'}
        </span>
      </div>

      {/* Prompt zone */}
      <div
        className={cn(
          'relative z-10 flex-1 flex items-center h-full',
          s.promptPad,
          v.promptBg,
          !isDisabled && v.promptHover,
          'transition-all'
        )}
      >
        {/* Command text */}
        <span className={cn(
          'font-mono font-bold transition-colors',
          s.text,
          state ? 'text-current' : v.text
        )}>
          {displayCommand}
        </span>

        {/* Queued bouncing dots */}
        {state === 'queued' && (
          <div className="flex gap-1 ml-1">
            <div className={cn(s.dot, 'rounded-full bg-current animate-bounce')} style={{ animationDelay: '0ms' }} />
            <div className={cn(s.dot, 'rounded-full bg-current animate-bounce')} style={{ animationDelay: '150ms' }} />
            <div className={cn(s.dot, 'rounded-full bg-current animate-bounce')} style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>

      {/* Icon zone */}
      <div className={cn(
        'relative z-10 flex items-center justify-center h-full transition-colors',
        s.iconPad,
        state ? 'text-current' : v.icon
      )}>
        {displayIcon}
      </div>

      {/* Pulsing glow for ready state */}
      {state === 'ready' && (
        <div
          className="absolute inset-0 pointer-events-none rounded z-0"
          style={{
            boxShadow: `inset 0 0 15px ${v.shadow}`,
            animation: 'showcase-slot-pulse 2s ease-in-out infinite',
          }}
        />
      )}
    </button>
  );

  if (isDisabled && disabledReason) {
    return (
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="top" className="bg-zinc-900 border-zinc-700 text-zinc-300">
            {disabledReason}
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return button;
}
