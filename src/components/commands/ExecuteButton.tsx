import { cn } from '@/lib/utils';
import { Loader2, Zap, CheckCircle2 } from 'lucide-react';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { ExecuteButtonState } from './types';

interface ExecuteButtonProps {
  state: ExecuteButtonState;
  onClick: () => void;
  disabledReason?: string;
}

const stateLabels: Record<ExecuteButtonState, string> = {
  disabled: 'GENERATE',
  ready: 'GENERATE',
  charging: 'CHARGING...',
  submitting: 'INITIALIZING...',
  queued: 'IN_QUEUE...',
  processing: 'GENERATING...',
  success: 'COMPLETE',
};

const shadowColor = 'rgba(34,211,238,0.5)';

export function ExecuteButton({ state, onClick, disabledReason }: ExecuteButtonProps) {
  const isDisabled = state === 'disabled';
  const isLoading = ['charging', 'submitting', 'queued', 'processing'].includes(state);
  const isSuccess = state === 'success';

  const button = (
    <button
      onClick={onClick}
      disabled={isDisabled || isLoading || isSuccess}
      className={cn(
        'relative w-full py-3 px-6 overflow-hidden',
        'font-bold text-sm tracking-[0.2em] uppercase',
        'border-2 rounded transition-all duration-300',
        !isDisabled &&
          !isLoading &&
          !isSuccess && [
            'bg-cyan-500/20 hover:bg-cyan-500/30',
            'text-cyan-400',
            'border-current',
            'shadow-[0_0_20px_rgba(34,211,238,0.5)]',
            'hover:scale-[1.02]',
            'active:scale-[0.98]',
          ],
        'focus-visible:ring-2 focus-visible:ring-cyan-400/80 focus-visible:ring-offset-1 focus-visible:ring-offset-black focus-visible:outline-none',
        isDisabled && ['bg-zinc-800/30 text-zinc-600 border-zinc-700/50', 'cursor-not-allowed'],
        isLoading && ['bg-cyan-500/20 text-cyan-400 border-current opacity-80', 'cursor-wait'],
        isSuccess && ['bg-green-500/20 text-green-400 border-green-500/50', 'shadow-[0_0_20px_rgba(34,197,94,0.5)]']
      )}
    >
      {/* Charging gradient sweep */}
      {state === 'charging' && (
        <div
          className="absolute inset-0 pointer-events-none"
          style={{
            background: `linear-gradient(90deg, transparent, ${shadowColor}, transparent)`,
            backgroundSize: '200% 100%',
            animation: 'showcase-charge 1s linear infinite',
          }}
        />
      )}

      {/* Processing scan line */}
      {state === 'processing' && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden">
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
      {isSuccess && <div className="absolute inset-0 bg-green-500/30 animate-[showcase-success_0.5s_ease-out]" />}

      {/* Button content */}
      <div className="relative flex items-center justify-center gap-2">
        {isLoading ? (
          <Loader2 className="w-5 h-5 animate-spin" />
        ) : isSuccess ? (
          <CheckCircle2 className="w-5 h-5" />
        ) : (
          <Zap className={cn('w-5 h-5', !isDisabled && 'drop-shadow-[0_0_6px_currentColor]')} />
        )}
        <span>{stateLabels[state]}</span>

        {/* Queued bouncing dots */}
        {state === 'queued' && (
          <div className="flex gap-1 ml-1">
            <div className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>

      {/* Pulsing glow for ready state */}
      {state === 'ready' && (
        <div
          className="absolute inset-0 pointer-events-none rounded"
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
