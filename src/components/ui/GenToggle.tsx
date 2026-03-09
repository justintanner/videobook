import { cn } from '@/lib/utils';

interface GenToggleProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly T[];
  disabled?: boolean;
  compact?: boolean;
}

export function GenToggle<T extends string>({ value, onChange, options, disabled, compact }: GenToggleProps<T>) {
  return (
    <div
      className={cn(
        'inline-flex border border-primary/30 rounded overflow-hidden',
        'bg-black/40',
        disabled && 'opacity-50'
      )}
    >
      {options.map((option, index) => (
        <button
          key={option}
          type="button"
          onClick={() => !disabled && onChange(option)}
          disabled={disabled}
          className={cn(
            'font-mono font-bold tracking-wider',
            'transition-all duration-200',
            compact ? 'px-1.5 h-5 text-[9px]' : 'px-4 h-9 text-xs',
            // Add border between items
            index > 0 && 'border-l border-primary/30',
            // Active state
            value === option
              ? 'bg-primary/20 text-primary shadow-[inset_0_0_12px_rgba(0,255,255,0.3)]'
              : 'text-primary/50 hover:text-primary/80 hover:bg-primary/5',
            'focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:z-10 focus-visible:outline-none',
            disabled && 'cursor-not-allowed'
          )}
        >
          {option}
        </button>
      ))}
    </div>
  );
}
