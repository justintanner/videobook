import { useRef, useEffect, useLayoutEffect, useState, type CSSProperties, type RefObject } from 'react';
import { AudioWaveform, Braces, Film, Image as ImageIcon } from 'lucide-react';
import { createPortal } from 'react-dom';
import { cn } from '@/lib/utils';
import { CommandBadge } from './CommandBadge';
import { resolveIcon } from '@/lib/command-icons';
import {
  MENU_MAX_H,
  MENU_Z,
  measureMenuPosition,
  menuPortalHost,
  type MenuPosition,
} from './autocomplete-position';

type ColorScheme = 'cyan' | 'amber' | 'violet';

interface AutocompleteItem {
  type: 'command' | 'mention';
  value: string;
  label: string;
  description: string;
  example?: string;
  category?: 'action' | 'project' | 'context_menu' | 'viewer';
  icon?: string;
  colorScheme: ColorScheme;
  // Optional left-hand thumbnail (e.g. the poster frame of the cell a grid
  // address points at).
  thumbnailSrc?: string | null;
  // Media kind behind the row, used for the glyph when there is no poster.
  mediaKind?: string;
  // Free-text cell label, display only — shown between the slug and the facts.
  caption?: string | null;
  // An empty grid square: no media, nothing to say about it. These collapse
  // into a single trailing chip row instead of one line each.
  empty?: boolean;
}

interface AutocompleteDropdownProps {
  items: AutocompleteItem[];
  selectedIndex: number;
  onSelect: (item: AutocompleteItem) => void;
  onHover: (index: number) => void;
  /**
   * Element to pin the menu to. When set, the menu is portaled out of the field
   * with position:fixed so overflow:hidden / overflow-y-auto ancestors (gen panel,
   * drawers, popovers) cannot clip it. It lands inside the anchor's open <dialog>
   * when there is one: a modal dialog sits in the top layer, so a menu portaled to
   * document.body would paint behind it however high its z-index.
   */
  anchorRef?: RefObject<HTMLElement | null>;
  /** Prefer opening above the anchor when space allows (chat bar). Default true. */
  preferAbove?: boolean;
  /** Fixed width override (px). Defaults to the anchor's width. */
  widthPx?: number;
}

function measurePos(
  el: HTMLElement,
  preferAbove: boolean,
  widthPx?: number,
): MenuPosition {
  const r = el.getBoundingClientRect();
  return measureMenuPosition(
    { top: r.top, bottom: r.bottom, left: r.left, width: r.width },
    { width: window.innerWidth, height: window.innerHeight },
    preferAbove,
    widthPx,
  );
}

const THUMB_KIND_ICON = { size: 13, 'aria-hidden': true } as const;

function ThumbGlyph({ kind }: { kind?: string }) {
  if (kind === 'audio') return <AudioWaveform {...THUMB_KIND_ICON} />;
  if (kind === 'image') return <ImageIcon {...THUMB_KIND_ICON} />;
  if (kind === 'video' || kind === 'final') return <Film {...THUMB_KIND_ICON} />;
  return <Braces {...THUMB_KIND_ICON} />;
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
  const [pos, setPos] = useState<MenuPosition | null>(null);
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [failedThumbs, setFailedThumbs] = useState<readonly string[]>([]);
  const usePortal = anchorRef != null;

  useEffect(() => {
    const el = listRef.current?.querySelector(`[data-option-index="${selectedIndex}"]`);
    el?.scrollIntoView({ block: 'nearest' });
  }, [selectedIndex]);

  useLayoutEffect(() => {
    if (!usePortal || !anchorRef) return;
    const update = () => {
      const el = anchorRef.current;
      if (!el) return;
      setPos(measurePos(el, preferAbove, widthPx));
      setHost(menuPortalHost(el));
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
    'bg-background border border-primary/30 rounded-sm shadow-[0_18px_48px_rgba(0,0,0,0.62)] overflow-hidden',
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

  const numbered = items.map((item, index) => ({ item, index }));
  const rows = numbered.filter(({ item }) => !item.empty);
  const chips = numbered.filter(({ item }) => item.empty);

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
        {rows.map(({ item, index }) => {
          const Icon = item.icon ? resolveIcon(item.icon) : undefined;
          const thumb = item.thumbnailSrc && !failedThumbs.includes(item.thumbnailSrc)
            ? item.thumbnailSrc
            : null;
          const isMention = item.type === 'mention';
          const showThumb = thumb !== null || item.mediaKind !== undefined;
          return (
            <button
              key={`${item.value}-${index}`}
              type="button"
              data-option-index={index}
              className={cn(
                'w-full h-10 px-3 text-left text-sm transition-colors flex items-center gap-3',
                index === selectedIndex
                  ? 'bg-primary/20 text-primary shadow-[inset_2px_0_0_var(--color-primary)]'
                  : 'text-foreground hover:bg-white/5',
              )}
              onClick={() => onSelect(item)}
              onMouseEnter={() => onHover(index)}
            >
              {showThumb && (
                <span className="flex h-[30px] w-[52px] shrink-0 items-center justify-center overflow-hidden rounded-sm border border-primary/20 bg-[#07150e] text-primary/60">
                  {thumb
                    ? <img src={thumb} alt="" loading="lazy" decoding="async"
                        className="size-full object-cover"
                        onError={() => setFailedThumbs((current) =>
                          current.includes(thumb) ? current : [...current, thumb])} />
                    : <ThumbGlyph kind={item.mediaKind} />}
                </span>
              )}
              <CommandBadge value={item.label} colorScheme={item.colorScheme} />
              {item.example && item.example !== item.value ? (
                <span className="text-muted-foreground/50 text-xs font-mono min-w-0 flex-1 truncate">
                  {item.example.replace(item.value, '').trimStart()}
                </span>
              ) : isMention ? (
                <span className="text-xs min-w-0 flex-1 truncate text-[#cde8da]">
                  {item.caption}
                </span>
              ) : (
                <span className="text-muted-foreground text-xs min-w-0 flex-1 truncate">
                  {item.description}
                </span>
              )}
              {/* The facts stay right-aligned so they read as one column. */}
              {isMention && item.description && (
                <span className="shrink-0 text-[10px] tracking-[0.1em] text-[#8fb9a1]">
                  {item.description}
                </span>
              )}
              {Icon && !showThumb && <Icon className="size-3 shrink-0 opacity-50" />}
            </button>
          );
        })}

        {chips.length > 0 && (
          <div className="flex h-9 items-center gap-2 overflow-x-auto border-t border-primary/10 px-3">
            <span className="shrink-0 text-[10px] tracking-[0.14em] text-[#6f9a82]">EMPTY</span>
            {chips.map(({ item, index }) => (
              <button
                key={`${item.value}-${index}`}
                type="button"
                data-option-index={index}
                title={item.description}
                className={cn(
                  'shrink-0 rounded-sm border border-dashed px-1.5 py-0.5 font-mono text-xs font-bold transition-colors',
                  index === selectedIndex
                    ? 'border-primary/60 bg-primary/20 text-amber-300'
                    : 'border-primary/25 text-amber-400/80 hover:border-primary/50 hover:text-amber-300',
                )}
                onClick={() => onSelect(item)}
                onMouseEnter={() => onHover(index)}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );

  if (usePortal) {
    // Wait one frame for measure so we don't flash at 0,0.
    if (!pos || !host || typeof document === 'undefined') return null;
    return createPortal(menu, host);
  }
  return menu;
}

export { AutocompleteDropdown };
export type { AutocompleteItem };
