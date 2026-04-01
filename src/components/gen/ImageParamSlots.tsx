import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
import type { JSONSchemaProperty, ResolvedAsset } from './types';
import { cn } from '@/lib/utils';
import { stripSlugPrefix } from '@/lib/slugs';

interface AssetFieldInfo {
  name: string;
  schema: JSONSchemaProperty;
  value: unknown;
  required?: boolean;
}

interface ImageParamSlotsProps {
  assetFields: AssetFieldInfo[];
  resolvedAssets?: ResolvedAsset[];
  droppedAssets?: Map<string, ResolvedAsset>;
  imageSlots?: { min: number; max: number } | null;
  onChange: (fieldName: string, value: unknown, droppedAsset?: ResolvedAsset) => void;
  disabled?: boolean;
  inline?: boolean;
  modelKey?: string;
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

export function ImageParamSlots({
  assetFields,
  resolvedAssets,
  droppedAssets,
  imageSlots,
  onChange,
  disabled,
  inline,
  modelKey,
}: ImageParamSlotsProps) {
  if (assetFields.length === 0) {
    return null;
  }

  const isVideoField = assetFields.some((f) => f.name === 'video_slug');
  const assetType: 'image' | 'video' = isVideoField ? 'video' : 'image';
  const sectionLabel = isVideoField
    ? '/video'
    : modelKey === 'grok_imagine_ref'
      ? '/reference-images'
      : '/images';

  const arrayField = assetFields.find((f) => f.schema.type === 'array');
  const stringField = assetFields.find((f) => f.schema.type === 'string');
  const primaryField = arrayField || stringField;

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
  const maxSlots = Math.max(imageSlots?.max ?? 1, 1);
  const filledCount = currentSlugs.length;
  const canAddMore = filledCount < maxSlots;
  const needsMore = filledCount < minSlots;

  const handleSlotChange = (
    index: number,
    asset: { slug: string; src: string; type: 'image' | 'video' } | null,
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

  const slots: Array<{ slug: string | null; index: number; required: boolean }> = [];

  currentSlugs.forEach((slug, idx) => {
    slots.push({ slug, index: idx, required: idx < minSlots });
  });

  const emptySlotCount = Math.max(
    minSlots - filledCount,
    canAddMore ? 1 : 0
  );

  for (let i = 0; i < emptySlotCount; i++) {
    const idx = filledCount + i;
    slots.push({ slug: null, index: idx, required: idx < minSlots });
  }

  const slotCountLabel =
    minSlots === maxSlots
      ? `${filledCount}/${maxSlots}`
      : minSlots > 0
        ? `${filledCount}/${minSlots}-${maxSlots}`
        : `${filledCount}/${maxSlots}`;

  return (
    <div className="rounded border border-cyan-500/15 bg-cyan-500/[0.03]">
      <div className="flex items-center gap-2 px-3 py-1.5 rounded-t border-b border-cyan-500/30 bg-cyan-500/15">
        <span className="font-mono font-bold text-xs tracking-widest text-cyan-400">{sectionLabel}</span>
        <span className={cn('ml-auto text-[10px] font-mono', needsMore ? 'text-yellow-400' : 'text-cyan-400/50')}>
          {slotCountLabel}
        </span>
      </div>
      <div className="px-3 py-2.5 space-y-2">
        {needsMore && <p className="text-[10px] text-yellow-400/80 font-mono">{minSlots - filledCount} more required</p>}
        <div className={inline ? 'flex flex-wrap gap-2' : 'flex flex-col gap-2'}>
          {slots.map(({ slug, index, required }) => (
            <div
              key={`slot-${index}`}
              className={cn('relative', required && !slug && 'ring-1 ring-yellow-400/50 rounded')}
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
                acceptTypes={[assetType]}
              />
              {required && !slug && (
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-yellow-400 rounded-full" title="Required" />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
