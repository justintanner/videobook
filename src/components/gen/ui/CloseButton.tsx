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
        'w-6 h-6 flex items-center justify-center',
        'text-muted-foreground transition-colors duration-150 rounded',
        'hover:text-primary hover:bg-primary/10',
        'focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:outline-none',
        'disabled:opacity-50 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-muted-foreground',
        className
      )}
      title="Close (ESC)"
    >
      <X className="w-4 h-4 stroke-[2.5]" />
    </button>
  );
}
