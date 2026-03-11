import { cn } from '@/lib/utils';
import { Volume2, Loader2, Play, Square, RefreshCw } from 'lucide-react';

interface ProofReadButtonProps {
  audioUrl: string | null;
  isPlaying: boolean;
  isPending: boolean;
  dialogDirty: boolean;
  disabled: boolean;
  onPlay: () => void;
  onRegenerate: () => void;
  audioRef: React.RefObject<HTMLAudioElement | null>;
}

type ButtonState = 'initial' | 'pending' | 'play' | 'playing' | 'dirty';

function deriveState(
  props: Pick<ProofReadButtonProps, 'audioUrl' | 'isPlaying' | 'isPending' | 'dialogDirty'>
): ButtonState {
  if (props.isPending) return 'pending';
  if (!props.audioUrl) return 'initial';
  if (props.dialogDirty) return 'dirty';
  if (props.isPlaying) return 'playing';
  return 'play';
}

const stateConfig: Record<ButtonState, { icon: typeof Play; label: string; red: boolean; spin: boolean }> = {
  initial: { icon: Volume2, label: 'Proof Read', red: false, spin: false },
  pending: { icon: Loader2, label: 'Reading...', red: false, spin: true },
  play: { icon: Play, label: 'Play', red: false, spin: false },
  playing: { icon: Square, label: 'Stop', red: true, spin: false },
  dirty: { icon: RefreshCw, label: 'Regenerate', red: false, spin: false },
};

export function ProofReadButton({
  audioUrl,
  isPlaying,
  isPending,
  dialogDirty,
  disabled,
  onPlay,
  onRegenerate,
}: ProofReadButtonProps) {
  const state = deriveState({ audioUrl, isPlaying, isPending, dialogDirty });
  const { icon: Icon, label, red, spin } = stateConfig[state];

  const isActionPlay = state === 'play' || state === 'playing';
  const handleClick = isActionPlay ? onPlay : onRegenerate;
  const isDisabled = state === 'pending' || disabled;

  return (
    <button
      onClick={handleClick}
      disabled={isDisabled}
      className={cn(
        'h-5 px-1.5 font-bold text-[10px] tracking-wider shrink-0 rounded',
        'border',
        red
          ? 'bg-red-500/20 border-red-400/50 text-red-400 hover:bg-red-500/30 hover:border-red-400/70 shadow-[0_0_8px_rgba(255,80,80,0.3)]'
          : 'bg-primary/20 border-primary/40 text-primary hover:bg-primary/30 hover:border-primary/60 shadow-[0_0_8px_rgba(0,255,255,0.3)]',
        'disabled:opacity-30 disabled:cursor-not-allowed',
        'transition-all duration-200',
        'flex items-center justify-center gap-1'
      )}
    >
      <Icon className={cn('w-3 h-3', spin && 'animate-spin')} />
      <span>{label}</span>
    </button>
  );
}
