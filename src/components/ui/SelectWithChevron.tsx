import { cn } from '@/lib/utils';
import { inputBaseStyles, inputDisabledStyles, selectStyles } from '@/lib/form-styles';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';

interface SelectWithChevronProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  className?: string;
  children: ReactNode;
}

export function SelectWithChevron({ value, onChange, disabled, className, children }: SelectWithChevronProps) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        className={cn(
          'w-full h-[38px] px-3',
          inputBaseStyles,
          selectStyles,
          disabled && inputDisabledStyles,
          className
        )}
      >
        {children}
      </select>
      <ChevronDown
        className={cn('absolute right-2 top-1/2 -translate-y-1/2 w-4 h-4', 'text-primary/50 pointer-events-none')}
      />
    </div>
  );
}
