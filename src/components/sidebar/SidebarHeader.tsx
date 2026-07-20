import type { ReactNode } from 'react';
import { ArrowUp, ArrowDown, PanelLeftClose, PanelRightClose, PanelLeftOpen, PanelRightOpen } from 'lucide-react';
import { Tooltip, TooltipTrigger, TooltipContent } from '@/components/ui/tooltip';

type SortOrder = 'newest' | 'oldest';

interface SidebarHeaderProps {
  icon: ReactNode;
  title: string;
  collapsed: boolean;
  onToggle: () => void;
  side: 'left' | 'right';
  sortOrder?: SortOrder;
  onSortChange?: () => void;
}

function CollapsedSidebarHeader({
  title,
  side,
  onToggle,
}: {
  title: string;
  side: 'left' | 'right';
  onToggle: () => void;
}) {
  const ExpandIcon = side === 'left' ? PanelLeftOpen : PanelRightOpen;

  return (
    <div className="flex flex-col items-center gap-3 pt-2 cursor-pointer group" onClick={onToggle}>
      <div className="p-2 rounded group-hover:bg-primary/10 text-muted-foreground group-hover:text-primary transition-colors">
 <ExpandIcon className="size-5" />
      </div>
      <span className="text-xs font-semibold text-muted-foreground group-hover:text-primary uppercase tracking-[0.15em] transition-colors [writing-mode:vertical-rl]">
        {title}
      </span>
    </div>
  );
}

function SortButton({ sortOrder, onChange }: { sortOrder: SortOrder; onChange: () => void }) {
  const label = sortOrder === 'newest' ? 'Sort: Newest first' : 'Sort: Oldest first';
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          tabIndex={-1}
          onClick={onChange}
          className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
        >
 {sortOrder === 'newest' ? <ArrowDown className="size-3.5" /> : <ArrowUp className="size-3.5" />}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

export function SidebarHeader({ icon, title, collapsed, onToggle, side, sortOrder, onSortChange }: SidebarHeaderProps) {
  if (collapsed) {
    return <CollapsedSidebarHeader title={title} side={side} onToggle={onToggle} />;
  }

  const CollapseIcon = side === 'left' ? PanelLeftClose : PanelRightClose;

  return (
    <div className="flex items-center justify-between mb-2">
      <h2 className="text-sm font-bold text-muted-foreground uppercase tracking-wider flex items-center gap-2">
        {icon} {title}
      </h2>
      <div className="flex items-center gap-1">
        {sortOrder && onSortChange && <SortButton sortOrder={sortOrder} onChange={onSortChange} />}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              tabIndex={-1}
              onClick={onToggle}
              className="p-1 rounded text-muted-foreground hover:text-primary hover:bg-primary/10 transition-colors"
            >
 <CollapseIcon className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Collapse sidebar</TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
