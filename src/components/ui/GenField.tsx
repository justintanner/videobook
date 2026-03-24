import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface GenFieldProps {
  label: string;
  children: ReactNode;
  className?: string;
  required?: boolean;
  actions?: ReactNode;
}

export function GenField({ label, children, className, required, actions }: GenFieldProps) {
  return (
    <div className={cn('space-y-2', className)}>
      {/* Label */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold tracking-[0.15em] text-primary/70">{label}</span>
          {required && <span className="text-[8px] font-bold text-red-400/80 tracking-wider">*REQ</span>}
        </div>
        {actions}
      </div>

      {/* Field content */}
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
}

export function GenTextarea({ value, onChange, placeholder, disabled, rows = 3, autoFocus }: GenTextareaProps) {
  // Convert literal \n strings to actual newlines (handles escaped newlines from JSON)
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
        'bg-black/60 border border-primary/30 rounded',
        'text-primary/90 placeholder:text-primary/30',
        'font-mono text-xs leading-relaxed',
        'focus:outline-none focus:border-primary/60',
        'shadow-[inset_0_0_15px_rgba(0,255,255,0.1)]',
        'transition-all duration-200',
        disabled && 'opacity-50 cursor-not-allowed'
      )}
    />
  );
}
