import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface CommandButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  command: string;
  icon: ReactNode;
  chevron?: 'right' | 'down';
  className?: string;
}

export function CommandButton({ command, icon, chevron = 'right', className, ...props }: CommandButtonProps) {
  return (
    <button
      className={cn(
        'group flex items-center gap-0 h-8 border border-primary/25 rounded',
        'hover:border-primary/40 transition-all cursor-pointer',
        className
      )}
      {...props}
    >
      {/* Prompt zone */}
      <div
        className={cn(
          'flex-1 flex items-center gap-1.5 px-2.5 h-full',
          'bg-black/40 rounded-l',
          'shadow-[inset_0_0_10px_rgba(0,255,255,0.05)]',
          'group-hover:bg-black/60',
          'group-hover:shadow-[inset_0_0_10px_rgba(0,255,255,0.12)]',
          'transition-all'
        )}
      >
        {/* Chevron */}
        <span className={cn(
          'font-mono text-sm select-none transition-all',
          chevron === 'down'
            ? '-translate-y-1 text-primary/40 group-hover:text-primary/60 group-hover:animate-pulse'
            : 'text-primary/40 group-hover:text-primary/50'
        )}>
          {chevron === 'down' ? '\u2304' : '\u203A'}
        </span>

        {/* Blinking cursor (right chevron only) */}
        {chevron === 'right' && (
          <span
            className={cn(
              'w-px h-3 bg-primary/40',
              'opacity-0 group-hover:opacity-100 transition-opacity',
              'group-hover:animate-[cursor-blink_1s_step-end_infinite]'
            )}
          />
        )}

        {/* Command text */}
        <span className="font-mono text-xs font-bold tracking-widest text-primary/70 group-hover:text-primary/90 transition-colors">
          {command}
        </span>
      </div>

      {/* Icon zone */}
      <div className="flex items-center justify-center px-2 h-full text-primary/80 group-hover:text-primary transition-colors">
        {icon}
      </div>
    </button>
  );
}
