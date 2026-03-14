import { useRef, useEffect } from 'react';
import { cn } from '@/lib/utils';
import { CommandBadge } from './CommandBadge';
import { resolveIcon } from '@/lib/skill-icons';

type ColorScheme = 'cyan' | 'amber' | 'violet';

interface AutocompleteItem {
  type: 'command' | 'slug';
  value: string;
  label: string;
  description: string;
  example?: string;
  category?: 'action' | 'project' | 'context_menu';
  icon?: string;
  colorScheme: ColorScheme;
}

interface AutocompleteDropdownProps {
  items: AutocompleteItem[];
  selectedIndex: number;
  onSelect: (item: AutocompleteItem) => void;
  onHover: (index: number) => void;
}

function AutocompleteDropdown({ items, selectedIndex, onSelect, onHover }: AutocompleteDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  return (
    <div
      className={cn(
        'absolute bottom-full left-0 right-0 mb-2',
        'bg-background border border-primary/30 rounded-lg shadow-lg overflow-hidden z-50',
        'animate-in fade-in-0 zoom-in-95 duration-150',
        'origin-bottom'
      )}
    >
      <div ref={listRef} className="max-h-48 overflow-y-auto">
        {items.map((item, index) => {
          const Icon = item.icon ? resolveIcon(item.icon) : undefined;
          return (
            <button
              key={item.value}
              className={cn(
                'w-full px-3 py-2 text-left text-sm transition-colors flex items-center gap-2',
                index === selectedIndex ? 'bg-primary/20 text-primary' : 'text-foreground hover:bg-white/5'
              )}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(index)}
            >
              <CommandBadge value={item.label} colorScheme={item.colorScheme} />
              {item.example && item.example !== item.value ? (
                <span className="text-muted-foreground/50 text-xs font-mono truncate">{item.example.replace(item.value, '').trimStart()}</span>
              ) : (
                <span className="text-muted-foreground text-xs truncate">{item.description}</span>
              )}
              {Icon && <Icon className="ml-auto h-3 w-3 shrink-0 opacity-50" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

export { AutocompleteDropdown };
export type { AutocompleteItem, AutocompleteDropdownProps, ColorScheme };
