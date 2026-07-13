import { cn } from '@/lib/utils';
import type { GenTheme } from '@/components/gen/ui/gen-themes';
import { genThemes } from '@/components/gen/ui/gen-themes';

interface GenToggleProps<T extends string> {
  value: T;
  onChange: (value: T) => void;
  options: readonly T[];
  disabled?: boolean;
  compact?: boolean;
  theme?: GenTheme;
}

export function GenToggle<T extends string>({ value, onChange, options, disabled, compact, theme }: GenToggleProps<T>) {
  const t = theme ?? genThemes.image;

  // Disabled tiers: control groups dim to opacity-30 + pointer-events-none;
  // individual buttons use disabled:opacity-50 (+ disabled:hover suppression).
  return (
    <div className={cn('flex gap-1.5', disabled && 'opacity-30 pointer-events-none')}>
      {options.map((option) => {
        const active = value === option;
        return (
          <button
            key={option}
            type="button"
            onClick={() => !disabled && onChange(option)}
            disabled={disabled}
            className={cn(
              'rounded font-mono font-bold tracking-wider border transition-all duration-150',
              compact ? 'h-7 min-w-[36px] px-2.5 text-xs' : 'h-8 min-w-[48px] px-3 text-xs',
              active
                ? cn(t.activeBg, t.activeBorder, t.activeText)
                : cn(t.controlBg, t.inactiveBorder, t.inactiveText, t.inactiveHoverText, t.inactiveHoverBorder),
              'focus-visible:ring-1 focus-visible:ring-primary/60 focus-visible:outline-none',
            )}
            style={active ? { boxShadow: t.activeGlow } : undefined}
          >
            {option}
          </button>
        );
      })}
    </div>
  );
}
