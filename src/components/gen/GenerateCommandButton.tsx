import type React from 'react';
import { CheckCircle2, Loader2, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { variants } from '@/components/commands/command-styles';
import { LOADING_STATE, FOCUS_RING_BUTTON } from '@/components/ui/interaction-states';
import type { ExecuteButtonState } from '@/components/commands/types';
import type { UseEstimateCostResult } from '@/hooks/useEstimateCost';
import { formatUsd, isHeuristic, isUnknownEstimate, tooltipText } from '@/lib/format-cost';

interface GenerateCommandButtonProps {
  variant?: keyof typeof variants;
  state?: ExecuteButtonState;
  disabled?: boolean;
  disabledReason?: string;
  /** True while a generation of this panel's category is still running in the
   *  background (tracked via sync/ghost tiles) but the button itself is idle.
   *  Dims the button so it stops reading as bright/actionable — yet it stays
   *  clickable so more generations can be queued. */
  pending?: boolean;
  onClick?: () => void;
  cost: UseEstimateCostResult;
  className?: string;
}

const stateText: Record<ExecuteButtonState, string | null> = {
  disabled: null,
  ready: null,
  charging: '/charging...',
  submitting: 'generating',
  queued: '/in-queue...',
  processing: '/generating...',
  success: '/complete',
};

type SlotTone = 'normal' | 'stale' | 'loading';

interface SlotState {
  text: string;
  tone: SlotTone;
  tooltip: string;
}

function deriveSlotState(cost: UseEstimateCostResult): SlotState | null {
  // A transient estimate failure is not "unpriced": keep hiding the slot on hard
  // errors rather than showing a misleading "$?".
  if (cost.error) return null;
  // Nothing computed yet — first fetch in flight, or no calls derivable (e.g. no
  // model picked). isUnknownEstimate(null) is true, so this must come first.
  if (!cost.estimate) {
    return cost.loading ? { text: '···', tone: 'loading', tooltip: 'Estimating…' } : null;
  }
  const e = cost.estimate;
  // Unpriced model (e.g. Google Flow bills in credits): show an honest "$?"
  // rather than hiding the slot or inventing a number.
  if (isUnknownEstimate(e)) {
    return {
      text: '$?',
      tone: cost.stale ? 'stale' : 'normal',
      tooltip: `No pricing data for this provider/model — billed outside USD rates (e.g. plan credits).\n\n${tooltipText(e)}`,
    };
  }
  const text = `${isHeuristic(e) ? '~' : ''}${formatUsd(e.usd)}`;
  return { text, tone: cost.stale ? 'stale' : 'normal', tooltip: tooltipText(e) };
}

export function GenerateCommandButton({
  variant = 'image',
  state,
  disabled,
  disabledReason,
  pending,
  onClick,
  cost,
  className,
}: GenerateCommandButtonProps) {
  const v = variants[variant];
  const isDisabledVisual = state === 'disabled';
  const isLoading = state != null && ['charging', 'submitting', 'queued', 'processing'].includes(state);
  const isSuccess = state === 'success';
  // Background generation running while the button is otherwise idle.
  const isPendingIdle = !!pending && !state;
  const slotLocked = isDisabledVisual || isLoading || isSuccess || !!disabled;

  const slot = deriveSlotState(cost);

  const displayText = state ? stateText[state] ?? '/generate' : '/generate';

  let displayIcon = <Zap className="w-3.5 h-3.5" />;
  if (isLoading) displayIcon = <Loader2 className="w-3.5 h-3.5 animate-spin" />;
  else if (isSuccess) displayIcon = <CheckCircle2 className="w-3.5 h-3.5" />;

  const handleSlotClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (slotLocked) return;
    cost.refresh();
  };

  const button = (
    <button
      type="button"
      tabIndex={-1}
      disabled={isDisabledVisual || isLoading || isSuccess || !!disabled}
      onClick={onClick}
      className={cn(
        'group h-8 flex items-center gap-0 rounded overflow-hidden relative border border-primary/25',
        v.bg,
        'transition-all duration-300 cursor-pointer',
        isDisabledVisual && 'bg-zinc-800/30 text-zinc-600 border-zinc-700/50 shadow-none cursor-not-allowed',
        isLoading && LOADING_STATE,
        isSuccess && 'bg-green-500/20 text-green-400 border-green-500/50 shadow-[0_0_20px_rgba(34,197,94,0.5)]',
        // Muted-but-clickable: dims the whole chip (hue intact, unlike the gray
        // disabled state) so it no longer reads as the bright actionable button
        // while a generation is still running. Hover/scale below keeps it lively.
        isPendingIdle && 'opacity-60',
        !isDisabledVisual && !isLoading && !isSuccess && cn('hover:scale-[1.02] active:scale-[0.98]', v.hoverBorder),
        FOCUS_RING_BUTTON,
        v.focusRing,
        className,
      )}
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
            className="absolute inset-y-0 w-12"
            style={{
              background: `linear-gradient(90deg, transparent, ${v.shadow}, transparent)`,
              animation: 'showcase-scan 2s linear infinite',
            }}
          />
        </div>
      )}

      {/* Success flash */}
      {isSuccess && (
        <div className="absolute inset-0 bg-green-500/30 animate-[showcase-success_0.5s_ease-out] pointer-events-none z-0" />
      )}

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

      {/* Chevron zone */}
      <div className={cn(
        'relative z-10 flex items-center justify-center h-full px-2 transition-colors',
        isDisabledVisual ? 'text-zinc-600' : v.chevron,
      )}>
        {!state && (
          <span className={cn(
            'absolute w-px h-3',
            v.cursorBg,
            'opacity-0 group-hover:opacity-100 transition-opacity',
            'group-hover:animate-[cursor-blink_1s_step-end_infinite]',
          )} />
        )}
        <span className={cn(
          'font-mono select-none transition-all text-sm',
          !state && 'group-hover:opacity-0',
        )}>
          {'›'}
        </span>
      </div>

      {/* Prompt zone */}
      <div className={cn(
        'relative z-10 flex items-center h-full px-2.5 gap-1.5 transition-all',
        v.promptBg,
        !isDisabledVisual && v.promptHover,
      )}>
        <span className={cn(
          'font-mono font-bold text-xs tracking-widest transition-colors',
          isLoading || isSuccess ? 'text-current' : v.text,
        )}>
          {displayText}
        </span>

        {state === 'queued' && (
          <div className="flex gap-1 ml-1">
            <div className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '0ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '150ms' }} />
            <div className="w-1.5 h-1.5 rounded-full bg-current animate-bounce" style={{ animationDelay: '300ms' }} />
          </div>
        )}
      </div>

      {/* Coin-slot zone — only when we have a real number (or are computing one) */}
      {slot && (
        <TooltipProvider delayDuration={200}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role={slotLocked ? undefined : 'button'}
                tabIndex={-1}
                onClick={handleSlotClick}
                className={cn(
                  'relative z-10 flex items-center h-full px-2 gap-1 select-none',
                  'border-x border-current/20 bg-black/60',
                  'shadow-[inset_0_0_6px_rgba(0,0,0,0.85)]',
                  'overflow-hidden',
                  slotLocked ? 'cursor-default' : 'cursor-pointer',
                  slot.tone === 'loading' && 'text-current/60',
                  // While generating, the cost is locked and inactive — dim it to
                  // the button's current hue so it doesn't keep reading as the
                  // bright, actionable variant color (green/cyan).
                  slot.tone !== 'loading' && isLoading && 'text-current/60',
                  // Use the variant color in both 'normal' and 'stale' so the
                  // LCD never clashes with the surrounding button hue.
                  slot.tone !== 'loading' && !isLoading && !isDisabledVisual && v.text,
                  slot.tone !== 'loading' && !isLoading && isDisabledVisual && 'text-zinc-600',
                  slot.tone === 'stale' && 'opacity-60',
                )}
              >
                {/* Scanlines overlay — retro CRT readout */}
                <span
                  aria-hidden
                  className="absolute inset-0 pointer-events-none scanlines opacity-70"
                />

                {/* Flash on value change — re-keyed on text so the animation restarts */}
                <span
                  key={slot.text}
                  aria-hidden
                  className="absolute inset-0 pointer-events-none"
                  style={{
                    background: `linear-gradient(90deg, transparent, ${v.shadow}, transparent)`,
                    backgroundSize: '200% 100%',
                    animation: 'showcase-charge 0.5s linear 1',
                    opacity: 0.6,
                  }}
                />

                <span className={cn(
                  'relative font-mono text-[11px] leading-none tracking-wider tabular-nums',
                  slot.tone === 'loading' && 'animate-pulse',
                )}>
                  {slot.text}
                </span>
              </span>
            </TooltipTrigger>
            <TooltipContent
              side="top"
              className="whitespace-pre-line max-w-xs text-[11px] bg-zinc-900 border-zinc-700 text-zinc-300"
            >
              {slot.tooltip}
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      )}

      {/* Icon zone */}
      <div className={cn(
        'relative z-10 flex items-center justify-center h-full px-2 transition-colors',
        isLoading || isSuccess ? 'text-current' : v.icon,
      )}>
        {displayIcon}
      </div>
    </button>
  );

  if (isDisabledVisual && disabledReason) {
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
