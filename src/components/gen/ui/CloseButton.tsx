import { X } from 'lucide-react';
import { cn } from '@/lib/utils';

interface CloseButtonProps {
  onClick: () => void;
  disabled?: boolean;
  className?: string;
}

export function CloseButton({ onClick, disabled, className }: CloseButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'w-7 h-7 flex items-center justify-center',
        'text-primary/60 transition-all',
        'hover:bg-red-500/10 hover:text-red-400',
        'focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:rounded focus-visible:outline-none',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-primary/60',
        className
      )}
      title="Close (ESC)"
    >
      <X className="w-5 h-5 stroke-[2.5]" />
    </button>
  );
}
