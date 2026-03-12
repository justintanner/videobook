import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ExecuteButtonState } from '@/components/gen/types';

const sizes = {
  default: {
    button: 'h-8 border border-primary/25',
    promptPad: 'px-2.5 gap-1.5',
    iconPad: 'px-2',
    text: 'text-xs tracking-widest',
    chevron: 'text-sm',
    cursor: 'h-3',
  },
  lg: {
    button: 'h-12 border-2 border-cyan-400 bg-cyan-500/20 text-cyan-400 shadow-[0_0_20px_rgba(34,211,238,0.3)]',
    promptPad: 'px-4 gap-2',
    iconPad: 'px-3',
    text: 'text-sm tracking-[0.2em]',
    chevron: 'text-xl font-bold',
    cursor: 'h-4',
  },
} as const;

const stateCommands: Record<ExecuteButtonState, string | null> = {
  disabled: null,
  ready: null,
  charging: '/charging...',
  submitting: '/initializing...',
  queued: '/in_queue...',
  processing: '/generating...',
  success: '/complete',
};

const shadowColor = 'rgba(34,211,238,0.5)';

interface CommandButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  command: string;
  icon: ReactNode;
  chevron?: 'right' | 'down';
  size?: 'default' | 'lg';
  state?: ExecuteButtonState;
  disabledReason?: string;
  className?: string;
}

export function CommandButton({ command, icon, chevron = 'right', size = 'default', state, disabledReason, className, ...props }: CommandButtonProps) {
  const s = sizes[size];
  const isDisabled = state === 'disabled';
  const isLoading = state != null && ['charging', 'submitting', 'queued', 'processing'].includes(state);
  const isSuccess = state === 'success';
  const displayCommand = state ? (stateCommands[state] ?? command) : command;

  let displayIcon = icon;
  if (isLoading) displayIcon = <Loader2 className="w-5 h-5 animate-spin" />;
  else if (isSuccess) displayIcon = <CheckCircle2 className="w-5 h-5" />;

  const button = (
    <button
      disabled={isDisabled || isLoading || isSuccess || props.disabled}
      className={cn(
        'group flex items-center gap-0 rounded overflow-hidden relative',
        s.button,
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
            background: `linear-gradient(90deg, transparent, ${shadowColor}, transparent)`,
            backgroundSize: '200% 100%',
            animation: 'showcase-charge 1s linear infinite',
          }}
        />
      )}

      {/* Processing scan line */}
      {state === 'processing' && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
          <div
            className="absolute inset-y-0 w-12"
            style={{
              background: `linear-gradient(90deg, transparent, ${shadowColor}, transparent)`,
              animation: 'showcase-scan 2s linear infinite',
            }}
          />
        </div>
      )}

      {/* Success flash */}
      {isSuccess && <div className="absolute inset-0 bg-green-500/30 animate-[showcase-success_0.5s_ease-out] pointer-events-none z-0" />}

      {/* Prompt zone */}
      <div
        className={cn(
          'relative z-10 flex-1 flex items-center h-full',
          s.promptPad,
          'bg-black/40 rounded-l',
          'shadow-[inset_0_0_10px_rgba(0,255,255,0.05)]',
          !isDisabled && 'group-hover:bg-black/60',
          !isDisabled && 'group-hover:shadow-[inset_0_0_10px_rgba(0,255,255,0.12)]',
          'transition-all'
        )}
      >
        {/* Chevron */}
        <span className={cn(
          'font-mono select-none transition-all',
          s.chevron,
          isDisabled
            ? 'text-zinc-600'
            : chevron === 'down'
              ? '-translate-y-1 text-primary/40 group-hover:text-primary/60 group-hover:animate-pulse'
              : 'text-primary/40 group-hover:text-primary/50'
        )}>
          {chevron === 'down' ? '\u2304' : '\u203A'}
        </span>

        {/* Blinking cursor (right chevron only, hide during state transitions) */}
        {chevron === 'right' && !state && (
          <span
            className={cn(
              'w-px bg-primary/40',
              s.cursor,
              'opacity-0 group-hover:opacity-100 transition-opacity',
              'group-hover:animate-[cursor-blink_1s_step-end_infinite]'
            )}
          />
        )}

        {/* Command text */}
        <span className={cn(
          'font-mono font-bold transition-colors',
          s.text,
          state ? 'text-current' : 'text-primary/70 group-hover:text-primary/90'
        )}>
          {displayCommand}
        </span>

        {/* Queued bouncing dots */}
        {state === 'queued' && (
          <div className="flex gap-1 ml-1">
            <div className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>

      {/* Icon zone */}
      <div className={cn(
        'relative z-10 flex items-center justify-center h-full transition-colors',
        s.iconPad,
        state ? 'text-current' : 'text-primary/80 group-hover:text-primary'
      )}>
        {displayIcon}
      </div>

      {/* Pulsing glow for ready state */}
      {state === 'ready' && (
        <div
          className="absolute inset-0 pointer-events-none rounded z-0"
          style={{
            boxShadow: `inset 0 0 15px ${shadowColor}`,
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
