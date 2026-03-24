import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';
import type { GenTheme } from '@/components/gen/ui/gen-themes';

interface GenFieldProps {
  label: string;
  children: ReactNode;
  className?: string;
  required?: boolean;
  actions?: ReactNode;
  theme?: GenTheme;
  horizontal?: boolean;
}

export function GenField({ label, children, className, required, actions, theme, horizontal }: GenFieldProps) {
  if (horizontal) {
    return (
      <div className={cn('flex items-center justify-between gap-3 min-h-[32px]', className)}>
        <span className={cn('text-xs font-mono tracking-wide shrink-0', theme?.labelText ?? 'text-primary/70')}>
          {label}
          {required && <span className="ml-1.5 text-[8px] font-bold text-red-400/80 tracking-wider">*REQ</span>}
        </span>
        <div className="flex items-center gap-2">
          {children}
          {actions}
        </div>
      </div>
    );
  }

  return (
    <div className={cn('space-y-2', className)}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className={cn('text-xs font-mono font-bold tracking-widest', theme?.labelText ?? 'text-primary/70')}>{label}</span>
          {required && <span className="text-[8px] font-bold text-red-400/80 tracking-wider">*REQ</span>}
        </div>
        {actions}
      </div>
      <div className="showcase-field-slot">{children}</div>
    </div>
  );
}

interface GenTextareaProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  rows?: number;
  autoFocus?: boolean;
  theme?: GenTheme;
}

export function GenTextarea({ value, onChange, placeholder, disabled, rows = 3, autoFocus, theme }: GenTextareaProps) {
  const normalizedValue = value.replace(/\\n/g, '\n');

  return (
    <textarea
      value={normalizedValue}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      disabled={disabled}
      rows={rows}
      autoFocus={autoFocus}
      className={cn(
        'w-full px-3 py-2 resize-none',
        'bg-black/60 rounded',
        theme ? cn(theme.controlBorder, 'border') : 'border border-primary/30',
        theme ? cn(theme.valueText, 'placeholder:text-primary/30') : 'text-primary/90 placeholder:text-primary/30',
        'font-mono text-sm leading-relaxed',
        'focus:outline-none',
        theme?.focusBorder ?? 'focus:border-primary/60',
        'transition-all duration-200',
        disabled && 'opacity-70 cursor-not-allowed'
      )}
    />
  );
}
