import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type CloseButtonTone = 'primary' | 'cyan' | 'violet' | 'emerald';

const toneClasses: Record<CloseButtonTone, string> = {
  primary: 'hover:text-primary hover:bg-primary/10 focus-visible:ring-primary/60',
  cyan: 'hover:text-cyan-300 hover:bg-cyan-500/10 focus-visible:ring-cyan-400/60',
  violet: 'hover:text-violet-300 hover:bg-violet-500/10 focus-visible:ring-violet-400/60',
  emerald: 'hover:text-emerald-300 hover:bg-emerald-500/10 focus-visible:ring-emerald-400/60',
};

interface CloseButtonProps {
  onClick: () => void;
  tone?: CloseButtonTone;
  disabled?: boolean;
  className?: string;
  title?: string;
  tabIndex?: number;
  'aria-label'?: string;
}

export function CloseButton({
  onClick,
  tone = 'primary',
  disabled,
  className,
  title = 'Close',
  tabIndex,
  'aria-label': ariaLabel = 'Close',
}: CloseButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      tabIndex={tabIndex}
      title={title}
      aria-label={ariaLabel}
      className={cn(
        'w-6 h-6 flex items-center justify-center',
        'text-muted-foreground transition-colors duration-150 rounded',
        'focus-visible:ring-1 focus-visible:outline-none',
        toneClasses[tone],
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
        className
      )}
    >
      <X className="w-4 h-4 stroke-[2.5]" />
    </button>
  );
}
