import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import { ChevronDown } from 'lucide-react';
import { sizes, variants } from './command-styles';
import { CHEVRON_DOWN_HACK } from '@/components/ui/interaction-states';

interface CommandDropdownOption {
  value: string;
  label: string;
}

interface CommandDropdownProps {
  command: string;
  value: string;
  options: CommandDropdownOption[];
  onChange: (value: string) => void;
  icon?: ReactNode;
  size?: 'sm' | 'default' | 'lg';
  variant?: keyof typeof variants;
  disabled?: boolean;
  className?: string;
}

export function CommandDropdown({
  command,
  value,
  options,
  onChange,
  icon,
  size = 'default',
  variant = 'image',
  disabled,
  className,
}: CommandDropdownProps) {
  const s = sizes[size];
  const v = variants[variant];
  const displayLabel = options.find((o) => o.value === value)?.label ?? value;

  return (
    <div
      className={cn(
        'group relative flex items-center gap-0 rounded overflow-hidden',
        s.button,
        v.bg,
        'transition-all duration-300',
        disabled && 'opacity-50 cursor-not-allowed',
        !disabled && cn('cursor-pointer', v.hoverBorder),
        'focus-within:ring-2',
        v.focusWithinRing,
        'focus-within:ring-offset-1 focus-within:ring-offset-black',
        className,
      )}
    >
      {/* Chevron zone */}
      <div
        className={cn(
          'flex items-center justify-center h-full transition-colors',
          s.chevronPad,
          disabled ? 'text-zinc-600' : v.chevronDown,
        )}
      >
        <span
          className={cn(
            'font-mono select-none transition-all',
            s.chevron,
            !disabled && CHEVRON_DOWN_HACK,
          )}
        >
          {'\u2304'}
        </span>
      </div>

      {/* Prompt zone — command (dim) + value (bright) */}
      <div
        className={cn(
          'flex-1 flex items-center h-full',
          s.promptPad,
          v.promptBg,
          !disabled && v.promptHover,
          'transition-all',
        )}
      >
        <span
          className={cn(
            'font-mono font-bold opacity-40 shrink-0',
            s.text,
          )}
        >
          {command}
        </span>
        <span
          className={cn(
            'font-mono font-bold transition-colors',
            s.text,
            disabled ? 'text-zinc-600' : v.text,
          )}
        >
          {displayLabel}
        </span>
      </div>

      {/* Icon zone */}
      <div
        className={cn(
          'flex items-center justify-center h-full transition-colors',
          s.iconPad,
          disabled ? 'text-zinc-600' : v.icon,
        )}
      >
        {icon ?? <ChevronDown className={s.iconSize} />}
      </div>

      {/* Invisible native select */}
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-label={command}
        className="absolute inset-0 opacity-0 cursor-pointer appearance-none"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}
