import { useEffect, useState } from 'react';
import { Mailbox } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { GenerationState } from './types';

type FlashPhase = 'idle' | 'burst' | 'glow' | 'settle';

interface PendingGenerationsButtonProps {
  state: GenerationState;
  generatingCount: number;
  readyCount: number;
  flashKey: number;
  onClick: () => void;
}

function getStateStyles(state: GenerationState, showIncoming: boolean) {
  if (showIncoming) {
    return {
      outer: 'border-amber-400/70 gen-ready-glow',
      chevronZone: 'text-amber-300/60 animate-pulse',
      promptBg: 'bg-black/50',
      promptShadow: 'shadow-[inset_0_0_10px_rgba(245,158,11,0.2)]',
      commandText: 'text-amber-300/90',
      iconZone: 'text-amber-300',
    };
  }
  if (state === 'ready') {
    return {
      outer: 'border-amber-500/50 gen-ready-steady',
      chevronZone: 'text-amber-400/50 animate-pulse',
      promptBg: 'bg-black/50',
      promptShadow: 'shadow-[inset_0_0_10px_rgba(245,158,11,0.12)]',
      commandText: 'text-amber-400/70',
      iconZone: 'text-amber-400/80',
    };
  }
  if (state === 'generating') {
    return {
      outer: 'border-amber-500/30 gen-pending',
      chevronZone: 'text-amber-500/40 animate-pulse',
      promptBg: 'bg-black/40',
      promptShadow: 'shadow-[inset_0_0_10px_rgba(245,158,11,0.08)]',
      commandText: 'text-amber-500/60',
      iconZone: 'text-amber-500/60',
    };
  }
  // inactive
  return {
    outer: 'border-amber-500/30 hover:border-amber-500/45',
    chevronZone: 'text-amber-500/50 group-hover:text-amber-500/70 group-hover:animate-pulse',
    promptBg: 'bg-black/40 group-hover:bg-black/60',
    promptShadow: 'shadow-[inset_0_0_10px_rgba(245,158,11,0.05)] group-hover:shadow-[inset_0_0_10px_rgba(245,158,11,0.1)]',
    commandText: 'text-amber-500/70 group-hover:text-amber-500/90',
    iconZone: 'text-amber-500/60 group-hover:text-amber-500/80',
  };
}

export function PendingGenerationsButton({
  state,
  generatingCount,
  readyCount,
  flashKey,
  onClick,
}: PendingGenerationsButtonProps) {
  const [flashPhase, setFlashPhase] = useState<FlashPhase>('idle');

  // Flash sequence triggered by flashKey changes (skip initial 0), only in ready state
  useEffect(() => {
    if (flashKey === 0 || state !== 'ready') return;

    const t0 = setTimeout(() => setFlashPhase('burst'), 0);
    const t1 = setTimeout(() => setFlashPhase('glow'), 200);
    const t2 = setTimeout(() => setFlashPhase('settle'), 1200);
    const t3 = setTimeout(() => setFlashPhase('idle'), 2000);

    return () => {
      clearTimeout(t0);
      clearTimeout(t1);
      clearTimeout(t2);
      clearTimeout(t3);
    };
  }, [flashKey, state]);

  const showIncoming = flashPhase === 'glow' || flashPhase === 'settle';
  const commandText = showIncoming ? 'incoming!' : '/inbox';
  const styles = getStateStyles(state, showIncoming);

  // Badge count
  const badgeCount = (() => {
    if (state === 'inactive') return null;
    if (state === 'ready') return readyCount;
    return generatingCount;
  })();

  return (
    <button
      onClick={onClick}
      className={cn(
        'group relative flex items-center gap-0 h-8 border rounded',
        'transition-all duration-300 cursor-pointer',
        styles.outer,
        'focus-visible:ring-2 focus-visible:ring-amber-400/80 focus-visible:ring-offset-1 focus-visible:ring-offset-black focus-visible:outline-none'
      )}
    >
      {/* Flash burst overlay */}
      {flashPhase === 'burst' && (
        <div
          className="absolute inset-0 rounded bg-white/30 pointer-events-none z-10"
          style={{ animation: 'gen-flash-burst 200ms ease-out forwards' }}
        />
      )}

      {/* Chevron zone */}
      <div className={cn(
        'flex items-center justify-center h-full px-2 transition-colors',
        styles.chevronZone
      )}>
        <span className="font-mono text-sm select-none -translate-y-1">&#x2304;</span>
      </div>

      {/* Prompt zone */}
      <div
        className={cn(
          'flex-1 flex items-center gap-1.5 h-full px-2.5',
          'transition-all',
          styles.promptBg,
          styles.promptShadow
        )}
      >
        <span className={cn('font-mono text-xs font-bold tracking-widest transition-colors', styles.commandText)}>
          {commandText}
        </span>
      </div>

      {/* Icon zone */}
      <div className={cn(
        'flex items-center justify-center px-2 h-full transition-colors',
        styles.iconZone
      )}>
        <Mailbox className="w-3.5 h-3.5" />
      </div>

      {/* Badge — absolute top-right */}
      {badgeCount != null && (
        <span
          className={cn(
            'absolute -top-1.5 -right-1.5 z-20',
            'text-[10px] font-mono font-bold leading-none px-1 min-w-[16px] h-4',
            'rounded-full inline-flex items-center justify-center',
            state === 'ready'
              ? 'bg-amber-500 text-black'
              : 'bg-amber-500/30 text-amber-400'
          )}
        >
          {badgeCount}
        </span>
      )}
    </button>
  );
}
