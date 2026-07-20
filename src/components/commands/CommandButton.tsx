import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { Loader2, CheckCircle2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ExecuteButtonState } from './types';
import { sizes, variants } from './command-styles';
import { LOADING_STATE, FOCUS_RING_BUTTON, CHEVRON_DOWN_HACK } from '@/components/ui/interaction-states';

const stateCommands: Record<string, Record<ExecuteButtonState, string | null>> = {
  default: {
    disabled: null,
    ready: null,
    charging: '/charging...',
    submitting: 'generating',
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

const commandStateOverrides: Record<string, Partial<Record<ExecuteButtonState, string>>> = {
  '/render': {
    processing: 'rendering',
    submitting: '/submitting...',
  },
};


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

export function CommandButton({ command, icon, chevron = 'right', size = 'default', variant = 'image', state, disabledReason, className, ...props }: CommandButtonProps) {
  const s = sizes[size];
  const v = variants[variant];
  const isDisabled = state === 'disabled';
  const isLoading = state != null && ['charging', 'submitting', 'queued', 'processing'].includes(state);
  const isSuccess = state === 'success';
  const overrideKey = Object.keys(commandStateOverrides).find(k => command.startsWith(k));
  const displayCommand = state ? ((overrideKey && commandStateOverrides[overrideKey]?.[state]) ?? stateCommands[size][state] ?? command) : command;

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
        state && isLoading && LOADING_STATE,
        state && isSuccess && 'bg-green-500/20 text-green-400 border-green-500/50 shadow-[0_0_20px_rgba(34,197,94,0.5)]',
        // Hover effects
        !isDisabled && !isLoading && !isSuccess && v.hoverBorder,
        state && !isDisabled && !isLoading && !isSuccess && 'hover:scale-[1.02] active:scale-[0.98]',
        FOCUS_RING_BUTTON,
        v.focusRing,
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
          chevron === 'down' && !isDisabled && CHEVRON_DOWN_HACK,
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
