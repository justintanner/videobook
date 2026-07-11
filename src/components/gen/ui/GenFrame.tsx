import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface GenFrameProps {
  children: ReactNode;
  header?: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function GenFrame({ children, header, footer, className }: GenFrameProps) {
  return (
    <div className={cn('relative w-full max-h-full flex flex-col overflow-hidden bg-zinc-950', className)}>
      <div className="relative flex-1 min-h-0 flex flex-col gap-2 border border-zinc-800/60">
        {header}
        {children}
        {footer}
      </div>
    </div>
  );
}
