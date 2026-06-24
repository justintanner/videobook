// Transparent, editable rich prompt. A real <textarea> (transparent text, visible
// caret) sits on top of a pointer-events-none overlay that paints the same text
// plus inline asset micro-thumbs. The "highlighted textarea" technique (same one
// ChatInput uses for a single line) generalised to multi-line: both layers share
// identical geometry + a monospace font, so AssetThumbChip's `Nch`-wide chips line
// up with the transparent token characters underneath. Editing is plain text
// editing — tokens are re-derived from the text each render, so a chip simply
// vanishes when you delete or change the characters under it.
//
// Assets are referenced two ways (both rendered as thumbs): "[Image N]" positional
// tokens and "@slug" mentions. Typing "@" opens slug autocomplete; dragging an
// asset from the sidebar inserts "@slug" at the caret.
import { useCallback, useMemo, useRef, useState } from 'react';
import { cn } from '@/lib/utils';
import { AutocompleteDropdown, type AutocompleteItem } from './AutocompleteDropdown';
import { AssetThumbChip, type ChipThumb } from './AssetThumbChip';
import { extractRichTokens, parseRichSegments, type RichToken } from './richPromptTokens';

export interface RichPromptFieldProps {
  value: string;
  onChange: (next: string) => void;
  // Map a token to its thumb (null → render the raw token text in a faint chip).
  resolveRef: (token: RichToken) => ChipThumb | null;
  assetSlugs?: string[]; // candidates for @-mention matching + autocomplete
  slugForAssetId?: (id: string) => string | null; // drag-drop: asset id → slug
  rows?: number;
  // Fill the parent's height instead of sizing to `rows`. The wrapper becomes a
  // flex column that grows (flex-1) and the textarea stretches to fill it, so the
  // field can absorb the slack in a fixed-height card. `rows` still seeds a min.
  fill?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  // Geometry shared by BOTH textarea and overlay (font, size, leading, padding,
  // width). Must be monospace for chip alignment. Background/border live on the
  // surface wrapper instead, so the two text layers align inside it.
  fieldClassName?: string;
  // Visible background + border + rounding on the wrapper (with focus-within for
  // the focus ring/border). The two inner layers stay transparent.
  surfaceClassName?: string;
  textClassName?: string; // visible text tint (painted by the overlay)
  caretClassName?: string; // caret color on the textarea
  // Extra key handling (e.g. prompt-history arrows). Return true if handled to
  // stop RichPromptField's own defaults.
  onKeyDownExtra?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => boolean;
}

const DEFAULT_FIELD = 'w-full px-3 py-2 font-mono text-sm leading-relaxed';
const DEFAULT_SURFACE = 'rounded border border-zinc-700 bg-black/60 focus-within:border-emerald-500/60';

export function RichPromptField({
  value,
  onChange,
  resolveRef,
  assetSlugs = [],
  slugForAssetId,
  rows = 4,
  fill = false,
  disabled,
  placeholder,
  autoFocus,
  fieldClassName = DEFAULT_FIELD,
  surfaceClassName = DEFAULT_SURFACE,
  textClassName = 'text-emerald-100/90',
  caretClassName = 'caret-emerald-300',
  onKeyDownExtra,
}: RichPromptFieldProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const [caret, setCaret] = useState(0);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  const [dropActive, setDropActive] = useState(false);

  const segments = useMemo(
    () => parseRichSegments(value, extractRichTokens(value, assetSlugs)),
    [value, assetSlugs],
  );

  // Active "@…" trigger immediately left of the caret.
  const trigger = useMemo(() => {
    const before = value.slice(0, caret);
    const m = before.match(/@([\w-]*)$/);
    if (!m) return null;
    return { filter: m[1], start: caret - (m[1].length + 1) };
  }, [value, caret]);

  const items = useMemo<AutocompleteItem[]>(() => {
    if (!trigger) return [];
    const f = trigger.filter.toLowerCase();
    return assetSlugs
      .filter((s) => s.toLowerCase().includes(f))
      .slice(0, 30)
      .map((s) => ({ type: 'slug' as const, value: `@${s}`, label: s, description: '', colorScheme: 'cyan' as const }));
  }, [trigger, assetSlugs]);

  // Reset the dropdown selection/dismissal as the trigger text changes (mirrors
  // ChatInput; setState-in-render is the same pattern it uses).
  const triggerKey = trigger ? trigger.filter : null;
  const prevTriggerRef = useRef<string | null>(null);
  if (triggerKey !== prevTriggerRef.current) {
    prevTriggerRef.current = triggerKey;
    if (dismissed) setDismissed(false);
    if (selectedIndex !== 0) setSelectedIndex(0);
  }

  const showSuggestions = trigger !== null && items.length > 0 && !dismissed;

  const syncCaret = useCallback(() => {
    const pos = taRef.current?.selectionStart ?? 0;
    setCaret(pos);
  }, []);

  const insertSlug = useCallback(
    (slug: string) => {
      if (!trigger) return;
      const before = value.slice(0, trigger.start);
      const after = value.slice(caret);
      const next = `${before}@${slug} ${after}`;
      onChange(next);
      setDismissed(true);
      const pos = before.length + slug.length + 2;
      requestAnimationFrame(() => {
        taRef.current?.focus();
        taRef.current?.setSelectionRange(pos, pos);
        setCaret(pos);
      });
    },
    [trigger, value, caret, onChange],
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      const json = e.dataTransfer.getData('application/json');
      if (!json) return;
      e.preventDefault();
      setDropActive(false);
      let id: string | null = null;
      try {
        const payload = JSON.parse(json) as { id?: unknown };
        if (typeof payload.id === 'string') id = payload.id.replace(/^@/, '');
      } catch {
        return;
      }
      if (!id) return;
      const slug = slugForAssetId?.(id) ?? id;
      const pos = taRef.current?.selectionStart ?? value.length;
      const before = value.slice(0, pos);
      const after = value.slice(pos);
      const sep = before.length > 0 && !before.endsWith(' ') ? ' ' : '';
      onChange(`${before}${sep}@${slug} ${after}`);
    },
    [slugForAssetId, value, onChange],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showSuggestions) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          setSelectedIndex((i) => (i + 1) % items.length);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          setSelectedIndex((i) => (i - 1 + items.length) % items.length);
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          insertSlug(items[selectedIndex].label);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          setDismissed(true);
          return;
        }
      }
      if (onKeyDownExtra?.(e)) return;
    },
    [showSuggestions, items, selectedIndex, insertSlug, onKeyDownExtra],
  );

  return (
    <div className={cn('relative', fill && 'flex min-h-0 flex-1 flex-col')}>
      {showSuggestions && (
        <AutocompleteDropdown
          items={items}
          selectedIndex={selectedIndex}
          onSelect={(item) => insertSlug(item.label)}
          onHover={setSelectedIndex}
        />
      )}
      <div
        className={cn('relative', fill && 'flex min-h-0 flex-1', surfaceClassName, dropActive && 'ring-1 ring-emerald-400/60')}
        onDragOver={(e) => {
          if (!e.dataTransfer.types.includes('application/json')) return;
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          setDropActive(true);
        }}
        onDragLeave={() => setDropActive(false)}
        onDrop={onDrop}
      >
        {/* Overlay — paints visible text + inline thumbs under the transparent textarea */}
        <div
          ref={overlayRef}
          aria-hidden="true"
          className={cn(
            fieldClassName,
            textClassName,
            'pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-normal',
          )}
        >
          {segments.map((seg, i) =>
            seg.type === 'text' ? (
              <span key={i}>{seg.value}</span>
            ) : (
              <AssetThumbChip
                key={i}
                widthCh={seg.value.length}
                rawText={seg.value}
                thumb={resolveRef(seg.token as RichToken)}
              />
            ),
          )}
          {/* trailing newline so the overlay's last empty line keeps height */}
          {'\n'}
        </div>
        <textarea
          ref={taRef}
          value={value}
          onChange={(e) => {
            onChange(e.target.value);
            requestAnimationFrame(syncCaret);
          }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={syncCaret}
          onSelect={syncCaret}
          onScroll={() => {
            if (overlayRef.current && taRef.current) {
              overlayRef.current.scrollTop = taRef.current.scrollTop;
              overlayRef.current.scrollLeft = taRef.current.scrollLeft;
            }
          }}
          onBlur={() => setDismissed(true)}
          disabled={disabled}
          autoFocus={autoFocus}
          rows={rows}
          spellCheck={false}
          placeholder={placeholder}
          className={cn(
            fieldClassName,
            caretClassName,
            'relative block resize-none border-0 bg-transparent text-transparent whitespace-pre-wrap break-normal scrollbar-hide',
            'focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed',
            'placeholder:text-zinc-500/40',
            fill && 'h-full w-full flex-1',
          )}
        />
      </div>
    </div>
  );
}
