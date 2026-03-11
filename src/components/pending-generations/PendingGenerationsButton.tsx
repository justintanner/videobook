import { useEffect, useState } from 'react';
import { Clapperboard } from 'lucide-react';
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
    // generating state
    return (
      <>
        {generatingCount}
        <span className="inline-block w-1.5 h-1.5 rounded-full bg-amber-500/80 animate-pulse ml-0.5 align-middle" />
      </>
    );
  })();

  // Label based on state
  const label = (() => {
    if (showIncoming) return 'INCOMING!';
    if (state === 'ready') return 'READY';
    if (state === 'generating') return 'INCOMING';
    return 'GENERATIONS';
  })();

  return (
    <button
      onClick={onClick}
      className={cn(
        'relative flex items-center justify-center gap-1.5 px-3 py-1',
        'text-xs font-mono font-bold tracking-widest uppercase',
        'border rounded transition-colors',
        // Flash glow override (transient, heavy animation)
        showIncoming && 'border-amber-400/70 text-amber-300 gen-ready-glow',
        // Ready: static amber glow
        !showIncoming && state === 'ready' && 'border-amber-500/50 text-amber-400 gen-ready-steady',
        // Generating: subtle pulse
        !showIncoming && state === 'generating' && 'border-amber-500/30 text-amber-500/60 gen-pending',
        // Inactive: muted but hover-responsive
        !showIncoming && state === 'inactive' && 'border-muted/30 text-muted-foreground/50 hover:border-muted/50'
      )}
    >
      {/* Flash burst overlay */}
      {flashPhase === 'burst' && (
        <div
          className="absolute inset-0 rounded bg-white/30 pointer-events-none"
          style={{ animation: 'gen-flash-burst 200ms ease-out forwards' }}
        />
      )}

      <Clapperboard className="w-3.5 h-3.5" />

      <span>{label}</span>

      {/* Combined badge */}
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
    </button>
  );
}
