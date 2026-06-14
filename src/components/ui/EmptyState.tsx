import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

// Shared "no data" placeholder. One treatment (mono, centered, muted) so every
// empty list/grid/panel reads the same. Use `size="sm"` inside dense dialogs and
// pass `className` to override layout (padding / alignment) for menu rows.

export type EmptyStateSize = 'sm' | 'md';

interface EmptyStateProps {
  children: ReactNode;
  size?: EmptyStateSize;
  className?: string;
}

const sizeClasses: Record<EmptyStateSize, string> = {
  sm: 'text-[11px] py-2',
  md: 'text-xs py-8',
};

export function EmptyState({ children, size = 'md', className }: EmptyStateProps) {
  return (
    <div className={cn('font-mono text-center text-muted-foreground/50', sizeClasses[size], className)}>
      {children}
    </div>
  );
}
