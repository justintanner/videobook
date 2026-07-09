import { useState, useCallback, useMemo } from 'react';
import { ImageIcon, Video, Music, X, Pin } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
import type { ModelOption, ModeSpec, ResolvedAsset } from '@/components/gen/types';
import type { Domain } from '@/theme/domains';
import { stripSlugPrefix } from '@/lib/slugs';
import {
  deriveStripSlots,
  combinedRefBudget,
  routeDrop,
  appendImageSlug,
  toggleFirstFramePin,
  type StripSlot,
  type CharacterEntity,
} from '@/components/gen/ui/media-strip';

const BUDGET_OK: Record<Domain, string> = {
  projects: 'text-zinc-400/50',
  image: 'text-cyan-400/50',
  video: 'text-violet-400/50',
  plan: 'text-emerald-400/50',
  final: 'text-amber-400/50',
};
const BUDGET_OVER = 'text-red-400';
const BUDGET_WARN = 'text-amber-400/70';

const MODE_LABEL: Record<Domain, string> = {
  projects: 'text-zinc-400/30',
  image: 'text-cyan-400/30',
  video: 'text-violet-400/30',
  plan: 'text-emerald-400/30',
  final: 'text-amber-400/30',
};

function videoThumbFallback(asset: ResolvedAsset): string {
  if (asset.thumbnailSrc) return asset.thumbnailSrc;
  if (asset.type === 'video' && asset.src) {
    return asset.src.replace(/\/[^/]+$/, '/original.jpg');
  }
  return asset.src || '';
}

function findThumbnail(
  slug: string,
  resolvedAssets: ResolvedAsset[],
  droppedAssets: Map<string, ResolvedAsset>,
): string {
  if (!slug) return '';
  const dropped = droppedAssets.get(slug);
  if (dropped) return videoThumbFallback(dropped);
  const clean = stripSlugPrefix(slug);
  const asset = resolvedAssets.find((a) => {
    const aClean = a.slug ? stripSlugPrefix(a.slug) : a.slug;
    return a.slug === slug || a.slug === clean || aClean === clean;
  });
  return asset ? videoThumbFallback(asset) : '';
}

function slotIcon(kind: StripSlot['kind']): React.ReactNode {
  if (kind === 'video') return <Video className="w-3 h-3" />;
  if (kind === 'audio') return <Music className="w-3 h-3" />;
  return <ImageIcon className="w-3 h-3" />;
}

export interface CharacterPillData {
  ref: string;
  name: string;
  thumbnailUrl: string | null;
  imageCount: number;
}

interface MediaStripProps {
  option: ModelOption;
  activeMode: ModeSpec | null;
  formValues: Record<string, unknown>;
  resolvedAssets: ResolvedAsset[];
  droppedAssets: Map<string, ResolvedAsset>;
  onChange: (field: string, value: unknown, dropped?: ResolvedAsset) => void;
  disabled: boolean;
  domain: Domain;
  characters: CharacterPillData[];
  onRemoveCharacter: (ref: string) => void;
  warnings: string[];
}

export function MediaStrip({
  option,
  activeMode,
  formValues,
  resolvedAssets,
  droppedAssets,
  onChange,
  disabled,
  domain,
  characters,
  onRemoveCharacter,
  warnings,
}: MediaStripProps) {
  const [dragOver, setDragOver] = useState(false);

  const slots = useMemo(() => deriveStripSlots(option), [option]);

  const charEntityMap = useMemo(() => {
    const m: Record<string, CharacterEntity | null> = {};
    for (const c of characters) m[c.ref] = { image_count: c.imageCount };
    return m;
  }, [characters]);

  const characterRefs = characters.map((c) => c.ref);
  const budget = useMemo(
    () => combinedRefBudget(formValues, characterRefs, activeMode, charEntityMap),
    [formValues, characterRefs, activeMode, charEntityMap],
  );

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const raw = e.dataTransfer.getData('text/plain');
    if (!raw) return;
    const parsed = JSON.parse(raw) as { slug?: string; type?: string };
    if (!parsed.slug || !parsed.type) return;
    const kind = (parsed.type === 'video' ? 'video' : parsed.type === 'audio' ? 'audio' : 'image') as 'image' | 'video' | 'audio';
    const route = routeDrop(kind, slots);
    if (route.action === 'append') {
      const updated = appendImageSlug(formValues, parsed.slug);
      onChange('image_slugs', updated);
    } else if (route.param) {
      const resolved = resolvedAssets.find((a) => a.slug === parsed.slug);
      const dropped = droppedAssets.get(parsed.slug);
      onChange(route.param, parsed.slug, resolved ?? dropped);
    }
  }, [slots, formValues, onChange, resolvedAssets, droppedAssets]);

  const handleTogglePin = useCallback((slug: string) => {
    const result = toggleFirstFramePin(formValues, slug);
    for (const [k, v] of Object.entries(result)) {
      onChange(k, v);
    }
  }, [formValues, onChange]);

  const pinnedSlug = typeof formValues.first_frame_slug === 'string' ? formValues.first_frame_slug : '';

  const budgetClass = budget.blocking ? BUDGET_OVER : budget.used > budget.max - 2 ? BUDGET_WARN : BUDGET_OK[domain];

  const hasPinnableImage = slots.some((s) => s.kind === 'image' && s.param !== 'first_frame_slug');

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      className={cn(
        'rounded border transition-colors duration-150',
        dragOver ? 'border-violet-400/60 bg-violet-400/5' : 'border-primary/20',
        domain === 'video' ? 'bg-black/40' : 'bg-black/40',
      )}
    >
      {/* Chip row */}
      <div className="flex items-center gap-1.5 px-2 py-2 overflow-x-auto">
        {slots.map((slot) => {
          const value = formValues[slot.param];
          if (slot.kind === 'image' && Array.isArray(value)) {
            const slugs = value as string[];
            return slugs.map((slug, i) => (
              <StripChip
                key={`${slot.param}-${i}`}
                slug={slug}
                label={slot.label}
                resolvedAssets={resolvedAssets}
                droppedAssets={droppedAssets}
                onRemove={() => {
                  const next = slugs.filter((_, idx) => idx !== i);
                  onChange(slot.param, next);
                }}
                onPin={hasPinnableImage ? () => handleTogglePin(slug) : undefined}
                pinned={pinnedSlug === slug}
                disabled={disabled}
                icon={slotIcon(slot.kind)}
              />
            ));
          }
          if (typeof value === 'string' && value) {
            return (
              <StripChip
                key={slot.param}
                slug={value}
                label={slot.label}
                resolvedAssets={resolvedAssets}
                droppedAssets={droppedAssets}
                onRemove={() => onChange(slot.param, '')}
                disabled={disabled}
                icon={slotIcon(slot.kind)}
              />
            );
          }
          return null;
        })}

        {/* Character pills */}
        {characters.map((c) => (
          <CharacterChip
            key={c.ref}
            name={c.name}
            thumbnailUrl={c.thumbnailUrl}
            imageCount={c.imageCount}
            onRemove={() => onRemoveCharacter(c.ref)}
            disabled={disabled}
          />
        ))}

        {/* Empty drop zone */}
        <AssetDropSlot
          value={null}
          onChange={(asset) => {
            if (!asset) return;
            const kind = asset.type === 'video' ? 'video' : asset.type === 'audio' ? 'audio' : 'image';
            const route = routeDrop(kind, slots);
            if (route.action === 'append') {
              const updated = appendImageSlug(formValues, asset.slug);
              onChange('image_slugs', updated, asset);
            } else if (route.param) {
              onChange(route.param, asset.slug, asset);
            }
          }}
          disabled={disabled}
          acceptTypes={['image', 'video', 'audio', 'character']}
          compact
          variant={domain === 'video' ? 'video' : 'image'}
        />

        {/* Budget meter + mode label (right-aligned) */}
        <div className="ml-auto flex items-center gap-3 shrink-0 pl-2">
          {(characterRefs.length > 0 || slots.some((s) => s.kind === 'image')) && (
            <span className={cn('text-[10px] font-mono whitespace-nowrap', budgetClass)}>
              {budget.meter}
            </span>
          )}
          {activeMode && (
            <span className={cn('text-[9px] font-mono uppercase tracking-wider whitespace-nowrap', MODE_LABEL[domain])}>
              {activeMode.label}
            </span>
          )}
        </div>
      </div>

      {/* Budget warning */}
      {budget.message && (
        <div className="px-3 pb-2 text-[10px] font-mono text-red-400/80">
          {budget.message}
        </div>
      )}

      {/* Inline warnings */}
      {warnings.length > 0 && (
        <div className="px-3 pb-2 space-y-0.5">
          {warnings.map((w, i) => (
            <p key={i} className="text-[10px] font-mono text-amber-400/60">{w}</p>
          ))}
        </div>
      )}
    </div>
  );
}

function StripChip({
  slug,
  label,
  resolvedAssets,
  droppedAssets,
  onRemove,
  onPin,
  pinned,
  disabled,
  icon,
}: {
  slug: string;
  label: string;
  resolvedAssets: ResolvedAsset[];
  droppedAssets: Map<string, ResolvedAsset>;
  onRemove: () => void;
  onPin?: () => void;
  pinned?: boolean;
  disabled?: boolean;
  icon?: React.ReactNode;
}) {
  const thumb = findThumbnail(slug, resolvedAssets, droppedAssets);
  return (
    <div
      className={cn(
        'group relative shrink-0 w-10 h-10 rounded overflow-hidden border',
        pinned ? 'border-amber-400/60 ring-1 ring-amber-400/40' : 'border-primary/30',
      )}
      title={label}
    >
      {thumb ? (
        <img src={thumb} alt={label} className="w-full h-full object-cover" />
      ) : (
        <div className="w-full h-full flex items-center justify-center text-primary/20">
          {icon ?? <ImageIcon className="w-3 h-3" />}
        </div>
      )}
      {/* Pin button */}
      {onPin && !disabled && (
        <button
          type="button"
          onClick={onPin}
          className={cn(
            'absolute top-0 left-0 w-4 h-4 flex items-center justify-center',
            'opacity-0 group-hover:opacity-100 transition-opacity',
            pinned ? 'opacity-100 text-amber-400' : 'text-primary/40 hover:text-amber-400',
          )}
          title={pinned ? 'Unpin first frame' : 'Pin as first frame'}
        >
          <Pin className="w-2.5 h-2.5" fill={pinned ? 'currentColor' : 'none'} />
        </button>
      )}
      {/* Remove button */}
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          className={cn(
            'absolute top-0 right-0 w-4 h-4 flex items-center justify-center',
            'bg-black/70 text-red-400/80 hover:text-red-400',
            'opacity-0 group-hover:opacity-100 transition-opacity',
          )}
          title="Remove"
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
}

function CharacterChip({
  name,
  thumbnailUrl,
  imageCount,
  onRemove,
  disabled,
}: {
  name: string;
  thumbnailUrl: string | null;
  imageCount: number;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const [broken, setBroken] = useState(false);
  const showImg = !!thumbnailUrl && !broken;
  return (
    <div
      className="group relative shrink-0 flex items-center gap-1.5 h-10 pl-1 pr-2 rounded border border-primary/30 bg-black/60"
      title={name}
    >
      <div className="w-8 h-8 rounded overflow-hidden shrink-0 flex items-center justify-center bg-black/60">
        {showImg ? (
          <img src={thumbnailUrl!} alt={name} className="w-full h-full object-cover" onError={() => setBroken(true)} />
        ) : (
          <ImageIcon className="w-3 h-3 text-primary/30" />
        )}
      </div>
      <div className="flex flex-col">
        <span className="text-[9px] font-mono text-primary/70 max-w-[60px] truncate leading-tight">{name}</span>
        {imageCount > 1 && (
          <span className="text-[8px] font-mono text-amber-400/50 leading-tight">×{imageCount}</span>
        )}
      </div>
      {!disabled && (
        <button
          type="button"
          onClick={onRemove}
          className={cn(
            'absolute -top-1 -right-1 w-4 h-4 flex items-center justify-center rounded-full',
            'bg-black/80 text-red-400/80 hover:text-red-400 border border-red-400/30',
            'opacity-0 group-hover:opacity-100 transition-opacity',
          )}
          title={`Remove ${name}`}
        >
          <X className="w-2.5 h-2.5" />
        </button>
      )}
    </div>
  );
}
