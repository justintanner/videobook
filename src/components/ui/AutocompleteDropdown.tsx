import { useRef, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { CommandBadge } from './CommandBadge';
import { resolveIcon } from '@/lib/command-icons';

type ColorScheme = 'cyan' | 'amber' | 'violet';

interface AutocompleteItem {
  type: 'command' | 'slug';
  value: string;
  label: string;
  description: string;
  example?: string;
  category?: 'action' | 'project' | 'context_menu' | 'viewer';
  icon?: string;
  colorScheme: ColorScheme;
  // Optional right-aligned thumbnail (e.g. project image assets in the @ menu).
  thumbnailSrc?: string | null;
  // When set, this item is a project image asset; committing it appends a ref
  // and inserts @referenceImage_N (handled by the consumer via onPickAsset).
  assetSlug?: string;
}

interface AutocompleteDropdownProps {
  items: AutocompleteItem[];
  selectedIndex: number;
  onSelect: (item: AutocompleteItem) => void;
  onHover: (index: number) => void;
  /**
   * Element to pin the menu to. When set, the menu is portaled to document.body
   * with position:fixed so overflow:hidden / overflow-y-auto ancestors (gen panel,
   * drawers, popovers) cannot clip it. z-[130] matches AssetMenu in the stack.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Prefer opening above the anchor when space allows (chat bar). Default true. */
  preferAbove?: boolean;
  /** Fixed width override (px). Defaults to the anchor's width. */
  widthPx?: number;
}

interface FixedPos {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placeAbove: boolean;
}

const MENU_GAP = 8;
const MENU_MAX_H = 192; // max-h-48
// Menus / popovers — above drawers (100) and nested modals (120); below toasts (140).
const MENU_Z = 130;

function measurePos(
  el: HTMLElement,
  preferAbove: boolean,
  widthPx?: number,
): FixedPos {
  const r = el.getBoundingClientRect();
  const spaceAbove = r.top - MENU_GAP;
  const spaceBelow = window.innerHeight - r.bottom - MENU_GAP;
  const placeAbove = preferAbove
    ? spaceAbove >= Math.min(MENU_MAX_H, spaceBelow) || spaceAbove > spaceBelow
    : spaceBelow >= spaceAbove;
  const maxHeight = Math.max(80, Math.min(MENU_MAX_H, placeAbove ? spaceAbove : spaceBelow));
  const top = placeAbove
    ? Math.max(MENU_GAP, r.top - MENU_GAP - maxHeight)
    : r.bottom + MENU_GAP;
  const width = widthPx ?? Math.max(r.width, 200);
  const left = Math.min(
    Math.max(MENU_GAP, r.left),
    window.innerWidth - width - MENU_GAP,
  );
  return { top, left, width, maxHeight, placeAbove };
}

function AutocompleteDropdown({
  items,
  selectedIndex,
  onSelect,
  onHover,
  anchorRef,
  preferAbove = true,
  widthPx,
}: AutocompleteDropdownProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<FixedPos | null>(null);
  const usePortal = anchorRef != null;

  useEffect(() => {
    const el = listRef.current?.children[selectedIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useLayoutEffect(() => {
    if (!usePortal || !anchorRef) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      setPos(measurePos(el, preferAbove, widthPx));
    };
    update();
    window.addEventListener('resize', update);
    // Capture scroll from any overflow ancestor so the menu tracks the field.
    window.addEventListener('scroll', update, true);
    return () => {
      window.removeEventListener('resize', update);
      window.removeEventListener('scroll', update, true);
    };
  }, [usePortal, anchorRef, preferAbove, widthPx, items.length]);

  const menuClass = cn(
    'bg-background border border-primary/30 rounded-lg shadow-lg overflow-hidden',
    'animate-in fade-in-0 zoom-in-95 duration-150',
    !usePortal && 'absolute bottom-full left-0 right-0 mb-2 z-50 origin-bottom',
    usePortal && pos?.placeAbove && 'origin-bottom',
    usePortal && pos && !pos.placeAbove && 'origin-top',
  );

  const menuStyle: CSSProperties | undefined =
    usePortal && pos
      ? {
          position: 'fixed',
          top: pos.top,
          left: pos.left,
          width: pos.width,
          zIndex: MENU_Z,
        }
      : undefined;

  const menu = (
    <div
      className={menuClass}
      style={menuStyle}
      onMouseDown={(e) => e.preventDefault()}
    >
      <div
        ref={listRef}
        className="overflow-y-auto"
        style={{ maxHeight: pos?.maxHeight ?? MENU_MAX_H }}
      >
        {items.map((item, index) => {
          const Icon = item.icon ? resolveIcon(item.icon) : undefined;
          return (
            <button
              key={`${item.value}-${index}`}
              type="button"
              className={cn(
                'w-full px-3 py-2 text-left text-sm transition-colors flex items-center gap-2',
                index === selectedIndex ? 'bg-primary/20 text-primary' : 'text-foreground hover:bg-white/5',
              )}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(index)}
            >
              <CommandBadge value={item.label} colorScheme={item.colorScheme} />
              {item.example && item.example !== item.value ? (
                <span className="text-muted-foreground/50 text-xs font-mono truncate">
                  {item.example.replace(item.value, '').trimStart()}
                </span>
              ) : (
                <span className="text-muted-foreground text-xs truncate">{item.description}</span>
              )}
              {item.thumbnailSrc && (
                <img
                  src={item.thumbnailSrc}
                  alt=""
                  className="ml-auto h-5 w-5 shrink-0 rounded object-cover border border-primary/20"
                  draggable={false}
                />
              )}
              {Icon && !item.thumbnailSrc && <Icon className="ml-auto h-3 w-3 shrink-0 opacity-50" />}
            </button>
          );
        })}
      </div>
    </div>
  );

  if (usePortal) {
    // Wait one frame for measure so we don't flash at 0,0.
    if (!pos || typeof document === 'undefined') return null;
    return createPortal(menu, document.body);
  }
  return menu;
}

export { AutocompleteDropdown };
export type { AutocompleteItem, AutocompleteDropdownProps, ColorScheme };
