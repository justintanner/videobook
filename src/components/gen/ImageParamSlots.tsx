import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
import type { JSONSchemaProperty, ResolvedAsset } from './types';
import { cn } from '@/lib/utils';
import { stripSlugPrefix } from '@/lib/slugs';
import { slugFieldAssetType } from './ui/fieldHelpers';
import { GenSection } from './ui/GenSection';
import type { Domain } from '@/theme/domains';

const SLOT_COUNT_TEXT: Record<Domain, string> = {
  projects: 'text-zinc-400/50',
  image: 'text-cyan-400/50',
  video: 'text-violet-400/50',
  plan: 'text-emerald-400/50',
  final: 'text-amber-400/50',
};

// "needs more" indicator (count, required label, ring, dot) tinted with the
// section's own domain hue. Brighter than the resting count to read as
// a soft prompt without competing with semantic error colors.
const NEEDS_MORE_TEXT: Record<Domain, string> = {
  projects: 'text-zinc-300',
  image: 'text-cyan-300',
  video: 'text-violet-300',
  plan: 'text-emerald-300',
  final: 'text-amber-300',
};

const NEEDS_MORE_LABEL: Record<Domain, string> = {
  projects: 'text-zinc-300/80',
  image: 'text-cyan-300/80',
  video: 'text-violet-300/80',
  plan: 'text-emerald-300/80',
  final: 'text-amber-300/80',
};

const NEEDS_MORE_RING: Record<Domain, string> = {
  projects: 'ring-zinc-400/50',
  image: 'ring-cyan-400/50',
  video: 'ring-violet-400/50',
  plan: 'ring-emerald-400/50',
  final: 'ring-amber-400/50',
};

const NEEDS_MORE_DOT: Record<Domain, string> = {
  projects: 'bg-zinc-400',
  image: 'bg-cyan-400',
  video: 'bg-violet-400',
  plan: 'bg-emerald-400',
  final: 'bg-amber-400',
};

type SlotAcceptType = 'image' | 'video' | 'audio' | 'character';

const acceptsForImageType = (t: 'image' | 'video' | 'audio'): SlotAcceptType[] =>
  t === 'image' ? ['image', 'character'] : [t];

interface AssetFieldInfo {
  name: string;
  schema: JSONSchemaProperty;
  value: unknown;
  required?: boolean;
}

/** Explicit slot descriptor for moded models — mode metadata drives the label,
 *  accepted asset kind, and per-mode min/max instead of field-name heuristics. */
export interface ExplicitAssetSlot {
  name: string;
  kind: 'image' | 'video' | 'audio';
  label: string;
  min?: number;
  max?: number | null;
  isArray: boolean;
  value: unknown;
  required?: boolean;
}

interface ImageParamSlotsProps {
  assetFields: AssetFieldInfo[];
  resolvedAssets?: ResolvedAsset[];
  droppedAssets?: Map<string, ResolvedAsset>;
  imageSlots?: { min: number; max: number | null } | null;
  onChange: (fieldName: string, value: unknown, droppedAsset?: ResolvedAsset) => void;
  disabled?: boolean;
  inline?: boolean;
  modelKey?: string;
  domain?: Domain;
  /** When set (moded models), render these slots explicitly and skip the
   *  field-name heuristic layout entirely. */
  slots?: ExplicitAssetSlot[];
}

interface ExplicitSlotsProps {
  slots: ExplicitAssetSlot[];
  resolvedAssets?: ResolvedAsset[];
  droppedAssets?: Map<string, ResolvedAsset>;
  onChange: (fieldName: string, value: unknown, droppedAsset?: ResolvedAsset) => void;
  disabled?: boolean;
  inline?: boolean;
  domain: Domain;
}

function ExplicitSlots({
  slots,
  resolvedAssets,
  droppedAssets,
  onChange,
  disabled,
  inline,
  domain,
}: ExplicitSlotsProps) {
  return (
    <div className="space-y-2">
      {slots.map((slot) => {
        if (slot.isArray) {
          return (
            <ArraySlotSection
              key={slot.name}
              field={{ name: slot.name, schema: { type: 'array' }, value: slot.value, required: slot.required }}
              imageSlots={{ min: slot.min ?? (slot.required ? 1 : 0), max: slot.max ?? null }}
              resolvedAssets={resolvedAssets}
              droppedAssets={droppedAssets}
              onChange={onChange}
              disabled={disabled}
              inline={inline}
              domain={domain}
              labelOverride={slot.label}
              assetKindOverride={slot.kind}
            />
          );
        }
        const slug = typeof slot.value === 'string' ? slot.value : '';
        return (
          <GenSection
            key={slot.name}
            label={slot.label.toLowerCase().replace(/\s+/g, '-')}
            color={domain}
            required={slot.required}
          >
            <AssetDropSlot
              value={slug ? { slug, src: findThumbnail(slug, resolvedAssets, droppedAssets), type: slot.kind } : null}
              onChange={(asset) => {
                if (asset) {
                  onChange(slot.name, asset.slug, {
                    slug: asset.slug,
                    src: asset.src,
                    thumbnailSrc: asset.thumbnailSrc,
                    type: asset.type,
                  });
                } else {
                  onChange(slot.name, '');
                }
              }}
              disabled={disabled}
              acceptTypes={acceptsForImageType(slot.kind)}
              variant={domain === 'video' ? 'video' : 'image'}
            />
          </GenSection>
        );
      })}
    </div>
  );
}

function videoThumbFallback(asset: ResolvedAsset): string {
  if (asset.thumbnailSrc) return asset.thumbnailSrc;
  if (asset.type === 'video' && asset.src) {
    return asset.src.replace(/\/[^/]+$/, '/original.jpg');
  }
  return asset.src || '';
}

function findThumbnail(
  slug: string,
  resolvedAssets?: ResolvedAsset[],
  droppedAssets?: Map<string, ResolvedAsset>
): string {
  if (!slug) return '';

  const dropped = droppedAssets?.get(slug);
  if (dropped) return videoThumbFallback(dropped);

  if (!resolvedAssets?.length) return '';

  const clean = stripSlugPrefix(slug);

  const asset = resolvedAssets.find((a) => {
    const aClean = a.slug ? stripSlugPrefix(a.slug) : a.slug;
    return a.slug === slug || a.slug === clean || aClean === clean;
  });
  return asset ? videoThumbFallback(asset) : '';
}

const SLUG_DISPLAY_LABELS: Record<string, string> = {
  first_clip: 'Continuation',
  audio: 'Voice',
  image_slugs: 'References',
  video_slugs: 'Ref Videos',
  character_image_slugs: 'Characters',
  motion_video_slugs: 'Motion',
};

function formatSlotCount(filled: number, min: number, max: number | null): string {
  if (max === null) return min > 0 ? `${filled}/${min}+` : `${filled}`;
  if (min === max) return `${filled}/${max}`;
  if (min > 0) return `${filled}/${min}-${max}`;
  return `${filled}/${max}`;
}

function prettifySlugFieldName(name: string): string {
  if (SLUG_DISPLAY_LABELS[name]) return SLUG_DISPLAY_LABELS[name];
  const base = name.replace(/_slug$/, '');
  if (SLUG_DISPLAY_LABELS[base]) return SLUG_DISPLAY_LABELS[base];
  return base
    .split('_')
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ');
}

interface NamedSlotListProps {
  fields: AssetFieldInfo[];
  defaultAssetType: 'image' | 'video';
  resolvedAssets?: ResolvedAsset[];
  droppedAssets?: Map<string, ResolvedAsset>;
  onChange: (fieldName: string, value: unknown, droppedAsset?: ResolvedAsset) => void;
  disabled?: boolean;
  domain: Domain;
}

function NamedSlotList({
  fields,
  defaultAssetType,
  resolvedAssets,
  droppedAssets,
  onChange,
  disabled,
  domain,
}: NamedSlotListProps) {
  return (
    <div className="space-y-2">
      {fields.map((field) => {
        const slug = typeof field.value === 'string' ? field.value : '';
        const label = prettifySlugFieldName(field.name);
        const fieldType = slugFieldAssetType(field.name);
        const acceptType = fieldType || defaultAssetType;
        return (
          <GenSection
            key={field.name}
            label={label.toLowerCase().replace(/\s+/g, '-')}
            color={domain}
            required={field.required}
          >
            <AssetDropSlot
              value={slug ? { slug, src: findThumbnail(slug, resolvedAssets, droppedAssets), type: acceptType } : null}
              onChange={(asset) => {
                if (asset) {
                  const da: ResolvedAsset = {
                    slug: asset.slug,
                    src: asset.src,
                    thumbnailSrc: asset.thumbnailSrc,
                    type: asset.type,
                  };
                  onChange(field.name, asset.slug, da);
                } else {
                  onChange(field.name, '');
                }
              }}
              disabled={disabled}
              acceptTypes={acceptsForImageType(acceptType)}
              variant={domain === 'video' ? 'video' : 'image'}
            />
          </GenSection>
        );
      })}
    </div>
  );
}

interface ArraySlotSectionProps {
  field: AssetFieldInfo;
  imageSlots?: { min: number; max: number | null } | null;
  resolvedAssets?: ResolvedAsset[];
  droppedAssets?: Map<string, ResolvedAsset>;
  onChange: (fieldName: string, value: unknown, droppedAsset?: ResolvedAsset) => void;
  disabled?: boolean;
  inline?: boolean;
  domain: Domain;
  /** Explicit-slots path (moded models) supplies label/kind from mode metadata
   *  instead of the field-name heuristics. */
  labelOverride?: string;
  assetKindOverride?: 'image' | 'video' | 'audio';
}

function ArraySlotSection({
  field,
  imageSlots,
  resolvedAssets,
  droppedAssets,
  onChange,
  disabled,
  inline,
  domain,
  labelOverride,
  assetKindOverride,
}: ArraySlotSectionProps) {
  const fieldAssetType = assetKindOverride ?? slugFieldAssetType(field.name);
  const sectionLabel = `/${(labelOverride ?? prettifySlugFieldName(field.name)).toLowerCase().replace(/\s+/g, '-')}`;
  const currentSlugs = Array.isArray(field.value) ? field.value.map(String).filter(Boolean) : [];
  const minSlots = imageSlots?.min ?? (field.required ? 1 : 0);
  const maxSlotsRaw = imageSlots?.max;
  const maxSlots: number | null = maxSlotsRaw === null ? null : Math.max(maxSlotsRaw ?? 5, 1);
  const filledCount = currentSlugs.length;
  const canAddMore = maxSlots === null || filledCount < maxSlots;
  const needsMore = filledCount < minSlots;

  const handleSlotChange = (
    index: number,
    asset: { slug: string; src: string; type: SlotAcceptType } | null,
    droppedAsset?: ResolvedAsset,
  ) => {
    const newValues = [...currentSlugs];
    if (asset) {
      if (index < newValues.length) {
        newValues[index] = asset.slug;
      } else {
        newValues.push(asset.slug);
      }
      onChange(field.name, newValues, droppedAsset);
    } else {
      newValues.splice(index, 1);
      onChange(field.name, newValues);
    }
  };

  const slots: Array<{ slug: string | null; index: number; required: boolean }> = [];
  currentSlugs.forEach((slug, idx) => {
    slots.push({ slug, index: idx, required: idx < minSlots });
  });
  const emptySlotCount = Math.max(minSlots - filledCount, canAddMore ? 1 : 0);
  for (let i = 0; i < emptySlotCount; i++) {
    const idx = filledCount + i;
    slots.push({ slug: null, index: idx, required: idx < minSlots });
  }

  const slotCountLabel = formatSlotCount(filledCount, minSlots, maxSlots);

  return (
    <GenSection
      label={sectionLabel.replace(/^\//, '')}
      color={domain}
      required={field.required}
      rightSlot={
        <span className={cn('text-[10px] font-mono', needsMore ? NEEDS_MORE_TEXT[domain] : SLOT_COUNT_TEXT[domain])}>
          {slotCountLabel}
        </span>
      }
      bodyClassName="px-3 py-2.5 space-y-2"
    >
      {needsMore && <p className={cn('text-[10px] font-mono italic', NEEDS_MORE_LABEL[domain])}>{minSlots - filledCount} more required</p>}
      <div className={inline ? 'flex flex-wrap gap-2' : 'flex flex-col gap-2'}>
        {slots.map(({ slug, index, required }) => (
          <div
            key={`slot-${index}`}
            className={cn('relative', required && !slug && cn('ring-1 rounded', NEEDS_MORE_RING[domain]))}
          >
            <AssetDropSlot
              value={slug ? { slug, src: findThumbnail(slug, resolvedAssets, droppedAssets), type: fieldAssetType } : null}
              onChange={(asset) => {
                if (asset) {
                  const da: ResolvedAsset = {
                    slug: asset.slug,
                    src: asset.src,
                    thumbnailSrc: asset.thumbnailSrc,
                    type: asset.type,
                  };
                  handleSlotChange(index, asset, da);
                } else {
                  handleSlotChange(index, null);
                }
              }}
              disabled={disabled}
              acceptTypes={acceptsForImageType(fieldAssetType)}
              variant={domain === 'video' ? 'video' : 'image'}
            />
            {required && !slug && (
              <span className={cn('absolute -top-1 -right-1 w-2 h-2 rounded-full', NEEDS_MORE_DOT[domain])} title="Required" />
            )}
          </div>
        ))}
      </div>
    </GenSection>
  );
}

export function ImageParamSlots({
  assetFields,
  resolvedAssets,
  droppedAssets,
  imageSlots,
  onChange,
  disabled,
  inline,
  modelKey,
  domain = 'image',
  slots,
}: ImageParamSlotsProps) {
  // Explicit-slots path: moded models supply slot metadata directly, bypassing
  // the field-name heuristics below.
  if (slots) {
    if (slots.length === 0) return null;
    return (
      <ExplicitSlots
        slots={slots}
        resolvedAssets={resolvedAssets}
        droppedAssets={droppedAssets}
        onChange={onChange}
        disabled={disabled}
        inline={inline}
        domain={domain}
      />
    );
  }

  if (assetFields.length === 0) {
    return null;
  }

  const isVideoField = assetFields.some((f) => f.name === 'video_slug');
  const assetType: 'image' | 'video' = isVideoField ? 'video' : 'image';

  const arrayFields = assetFields.filter((f) => f.schema.type === 'array');
  const stringFields = assetFields.filter((f) => f.schema.type === 'string');

  // Named-slot mode: multiple distinct string slug fields (e.g. first_frame_slug + last_frame_slug)
  // render one labeled slot per field instead of funneling everything through one primary field.
  const isNamedSlotMode = arrayFields.length === 0 && stringFields.length > 1;

  // Hybrid mode: both named string slots AND array slots exist
  // (e.g. Wan 2.7 Reference: first_frame_slug + audio_slug + image_slugs + video_slugs)
  const isHybridMode = arrayFields.length > 0 && stringFields.length > 0;

  // Multi-array mode: 2+ array slug fields with no string slots
  // (e.g. Kling 3.0 Motion Control: character_image_slugs + motion_video_slugs)
  const isMultiArrayMode = arrayFields.length > 1 && stringFields.length === 0;

  if (isNamedSlotMode) {
    return (
      <NamedSlotList
        fields={stringFields}
        defaultAssetType={assetType}
        resolvedAssets={resolvedAssets}
        droppedAssets={droppedAssets}
        onChange={onChange}
        disabled={disabled}
        domain={domain}
      />
    );
  }

  if (isHybridMode || isMultiArrayMode) {
    return (
      <div className="space-y-2">
        {isHybridMode && (
          <NamedSlotList
            fields={stringFields}
            defaultAssetType={assetType}
            resolvedAssets={resolvedAssets}
            droppedAssets={droppedAssets}
            onChange={onChange}
            disabled={disabled}
            domain={domain}
          />
        )}
        {arrayFields.map((af) => (
          <ArraySlotSection
            key={af.name}
            field={af}
            imageSlots={af === arrayFields[0] ? imageSlots : null}
            resolvedAssets={resolvedAssets}
            droppedAssets={droppedAssets}
            onChange={onChange}
            disabled={disabled}
            inline={inline}
            domain={domain}
          />
        ))}
      </div>
    );
  }

  const sectionLabel = isVideoField
    ? '/video'
    : modelKey === 'grok_imagine_ref'
      ? '/reference-images'
      : '/images';

  const primaryField = arrayFields[0] || stringFields[0];

  if (!primaryField) {
    return null;
  }

  const collectSlugs = (): string[] => {
    if (primaryField.schema.type === 'array') {
      return Array.isArray(primaryField.value) ? primaryField.value.map(String).filter(Boolean) : [];
    }
    if (primaryField.schema.type === 'string' && primaryField.value) {
      return [String(primaryField.value)];
    }
    return [];
  };

  const currentSlugs = collectSlugs();
  const minSlots = imageSlots?.min ?? 0;
  const maxSlotsRaw = imageSlots?.max;
  const maxSlots: number | null = maxSlotsRaw === null ? null : Math.max(maxSlotsRaw ?? 1, 1);
  const filledCount = currentSlugs.length;
  const canAddMore = maxSlots === null || filledCount < maxSlots;
  const needsMore = filledCount < minSlots;

  const handleSlotChange = (
    index: number,
    asset: { slug: string; src: string; type: SlotAcceptType } | null,
    droppedAsset?: ResolvedAsset
  ) => {
    if (primaryField.schema.type === 'array') {
      const newValues = [...currentSlugs];
      if (asset) {
        if (index < newValues.length) {
          newValues[index] = asset.slug;
        } else {
          newValues.push(asset.slug);
        }
        onChange(primaryField.name, newValues, droppedAsset);
      } else {
        newValues.splice(index, 1);
        onChange(primaryField.name, newValues);
      }
    } else {
      if (asset) {
        onChange(primaryField.name, asset.slug, droppedAsset);
      } else {
        onChange(primaryField.name, '');
      }
    }
  };

  const slotList: Array<{ slug: string | null; index: number; required: boolean }> = [];

  currentSlugs.forEach((slug, idx) => {
    slotList.push({ slug, index: idx, required: idx < minSlots });
  });

  const emptySlotCount = Math.max(
    minSlots - filledCount,
    canAddMore ? 1 : 0
  );

  for (let i = 0; i < emptySlotCount; i++) {
    const idx = filledCount + i;
    slotList.push({ slug: null, index: idx, required: idx < minSlots });
  }

  const slotCountLabel = formatSlotCount(filledCount, minSlots, maxSlots);

  return (
    <GenSection
      label={sectionLabel.replace(/^\//, '')}
      color={domain}
      rightSlot={
        <span className={cn('text-[10px] font-mono', needsMore ? NEEDS_MORE_TEXT[domain] : SLOT_COUNT_TEXT[domain])}>
          {slotCountLabel}
        </span>
      }
      bodyClassName="px-3 py-2.5 space-y-2"
    >
      {needsMore && <p className={cn('text-[10px] font-mono italic', NEEDS_MORE_LABEL[domain])}>{minSlots - filledCount} more required</p>}
      <div className={inline ? 'flex flex-wrap gap-2' : 'flex flex-col gap-2'}>
        {slotList.map(({ slug, index, required }) => (
          <div
            key={`slot-${index}`}
            className={cn('relative', required && !slug && cn('ring-1 rounded', NEEDS_MORE_RING[domain]))}
          >
            <AssetDropSlot
              value={slug ? { slug, src: findThumbnail(slug, resolvedAssets, droppedAssets), type: assetType } : null}
              onChange={(asset) => {
                if (asset) {
                  const da: ResolvedAsset = {
                    slug: asset.slug,
                    src: asset.src,
                    thumbnailSrc: asset.thumbnailSrc,
                    type: asset.type,
                  };
                  handleSlotChange(index, asset, da);
                } else {
                  handleSlotChange(index, null);
                }
              }}
              disabled={disabled}
              acceptTypes={acceptsForImageType(assetType)}
              variant={domain === 'video' ? 'video' : 'image'}
            />
            {required && !slug && (
              <span className={cn('absolute -top-1 -right-1 w-2 h-2 rounded-full', NEEDS_MORE_DOT[domain])} title="Required" />
            )}
          </div>
        ))}
      </div>
    </GenSection>
  );
}
