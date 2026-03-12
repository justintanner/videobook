import { useEffect, useState } from 'react';
import { Mailbox } from 'lucide-react';
import { cn } from '@/lib/utils';

type FlashPhase = 'idle' | 'burst' | 'glow' | 'settle';

export type GenerationState = 'inactive' | 'generating' | 'ready';

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
      promptBg: 'bg-black/50',
      promptShadow: 'shadow-[inset_0_0_10px_rgba(245,158,11,0.2)]',
      chevron: 'text-amber-300/60 animate-pulse',
      commandText: 'text-amber-300/90',
      iconZone: 'text-amber-300',
    };
  }
  if (state === 'ready') {
    return {
      outer: 'border-amber-500/50 gen-ready-steady',
      promptBg: 'bg-black/50',
      promptShadow: 'shadow-[inset_0_0_10px_rgba(245,158,11,0.12)]',
      chevron: 'text-amber-400/50 animate-pulse',
      commandText: 'text-amber-400/70',
      iconZone: 'text-amber-400/80',
    };
  }
  if (state === 'generating') {
    return {
      outer: 'border-amber-500/30 gen-pending',
      promptBg: 'bg-black/40',
      promptShadow: 'shadow-[inset_0_0_10px_rgba(245,158,11,0.08)]',
      chevron: 'text-amber-500/40 animate-pulse',
      commandText: 'text-amber-500/60',
      iconZone: 'text-amber-500/60',
    };
  }
  // inactive
  return {
    outer: 'border-amber-500/30 hover:border-amber-500/45',
    promptBg: 'bg-black/40 group-hover:bg-black/60',
    promptShadow: 'shadow-[inset_0_0_10px_rgba(245,158,11,0.05)] group-hover:shadow-[inset_0_0_10px_rgba(245,158,11,0.1)]',
    chevron: 'text-amber-500/50 group-hover:text-amber-500/70 group-hover:animate-pulse',
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

  // Badge content based on state
  const badgeContent = (() => {
    if (state === 'inactive') return null;
    if (state === 'ready' && generatingCount > 0)
      return (
        <>
          {readyCount}
          <span className="text-amber-500/60">/</span>
          {generatingCount}
          <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500/80 animate-pulse ml-0.5 align-middle" />
        </>
      );
    if (state === 'ready') return <>{readyCount}</>;
    return (
      <>
        {generatingCount}
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500/80 animate-pulse ml-0.5 align-middle" />
      </>
    );
  })();

  const commandText = showIncoming ? 'incoming!' : '/inbox';
  const styles = getStateStyles(state, showIncoming);

  return (
    <button
      onClick={onClick}
      className={cn(
        'group relative flex items-center gap-0 h-8 border rounded overflow-hidden',
        'transition-all cursor-pointer',
        styles.outer
      )}
    >
      {/* Flash burst overlay */}
      {flashPhase === 'burst' && (
        <div
          className="absolute inset-0 rounded bg-white/30 pointer-events-none z-10"
          style={{ animation: 'gen-flash-burst 200ms ease-out forwards' }}
        />
      )}

      {/* Prompt zone */}
      <div
        className={cn(
          'flex-1 flex items-center gap-1.5 px-2.5 h-full',
          'rounded-l transition-all',
          styles.promptBg,
          styles.promptShadow
        )}
      >
        {/* Chevron */}
        <span className={cn('font-mono text-sm select-none transition-all -translate-y-1', styles.chevron)}>&#x2304;</span>

        {/* Command text */}
        <span className={cn('font-mono text-xs font-bold tracking-widest transition-colors', styles.commandText)}>
          {commandText}
        </span>
      </div>

      {/* Icon zone */}
      <div className={cn('flex items-center justify-center gap-1 px-2 h-full transition-colors', styles.iconZone)}>
        <Mailbox className="w-3.5 h-3.5" />
        {badgeContent && (
          <span
            className={cn(
              'text-[10px] font-mono px-1.5 rounded inline-flex items-center gap-0.5',
              state === 'ready' ? 'bg-amber-500/20 text-amber-400' : 'bg-amber-500/10 text-amber-500/50'
            )}
          >
            {badgeContent}
          </span>
        )}
      </div>
    </button>
  );
}
