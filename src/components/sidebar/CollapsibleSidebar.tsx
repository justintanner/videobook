import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

interface CollapsibleSidebarProps {
  side: 'left' | 'right';
  collapsed: boolean;
  onToggle: () => void;
  padding?: string;
  gap?: string;
  collapsedWidth?: string;
  expandedWidth?: string;
  children: ReactNode;
}

export function CollapsibleSidebar({
  side,
  collapsed,
  padding = 'p-4',
  gap = 'gap-4',
  collapsedWidth = '48px',
  expandedWidth = '280px',
  children,
}: CollapsibleSidebarProps) {
  return (
    <aside
      className={cn(
        'flex flex-col overflow-hidden transition-all duration-300',
        side === 'left' ? 'border-r' : 'border-l',
        'border-border/30 bg-card/10',
        collapsed ? 'p-2 items-center' : cn(padding, gap)
      )}
      style={{ width: collapsed ? collapsedWidth : expandedWidth }}
    >
      {children}
    </aside>
  );
}
