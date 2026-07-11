import { useState } from 'react';
import { Puzzle, Plus, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { AssetDropSlot } from '@/components/ui/AssetDropSlot';
import type { JSONSchemaProperty, ResolvedAsset } from './types';
import { MAX_ELEMENT_GROUPS } from './types';
import { stripSlugPrefix } from '@/lib/slugs';
import { GenSection } from './ui/GenSection';
import { sectionTheme, type Domain } from '@/theme/domains';

interface ElementSkin {
  cardBorder: string;
  cardBg: string;
  labelText: string;
  countText: string;
  inputBorder: string;
  inputText: string;
  inputPlaceholder: string;
  inputFocus: string;
  charCount: string;
  addBorder: string;
  addText: string;
  addHover: string;
  addFocus: string;
  slotVariant: 'image' | 'video';
}

function elementSkin(domain: Domain): ElementSkin {
  const t = sectionTheme(domain);
  return {
    cardBorder: t.controlBorder,
    cardBg: t.controlBg,
    labelText: t.labelText,
    countText: t.labelText,
    inputBorder: t.controlBorder,
    inputText: t.activeText,
    inputPlaceholder: t.placeholderText,
    inputFocus: t.focusBorder,
    charCount: t.unitText,
    addBorder: t.controlBorder,
    addText: t.labelText,
    addHover: cn(t.inactiveHoverBorder, t.inactiveHoverText, t.controlHover),
    addFocus: t.focusBorder,
    slotVariant: domain === 'video' ? 'video' : 'image',
  };
}

const ELEMENT_SKINS: Record<Domain, ElementSkin> = {
  projects: elementSkin('projects'),
  image: elementSkin('image'),
  video: elementSkin('video'),
  notebook: elementSkin('notebook'),
  final: elementSkin('final'),
};

interface Asset {
  slug: string;
  filePath: string | null;
  thumbnailSrc?: string | null;
  type: string;
}

interface ElementGroupEditorProps {
  elementGroupIndices: number[];
  elementSchemas: Map<string, JSONSchemaProperty>;
  formValues: Record<string, unknown>;
  resolvedAssets?: ResolvedAsset[];
  droppedAssets?: Map<string, ResolvedAsset>;
  assets: Asset[];
  onChange: (fieldName: string, value: unknown, droppedAsset?: ResolvedAsset) => void;
  disabled?: boolean;
  domain?: Domain;
}

function findThumbnail(
  slug: string,
  droppedAssets?: Map<string, ResolvedAsset>,
  resolvedAssets?: ResolvedAsset[],
  projectAssets?: Asset[]
): string {
  if (!slug) return '';

  const dropped = droppedAssets?.get(slug);
  if (dropped) return dropped.thumbnailSrc || dropped.src || '';

  const clean = stripSlugPrefix(slug);

  if (resolvedAssets?.length) {
    const resolved = resolvedAssets.find((a) => {
      const aClean = a.slug ? stripSlugPrefix(a.slug) : a.slug;
      return a.slug === slug || a.slug === clean || aClean === clean;
    });
    if (resolved) return resolved.thumbnailSrc || resolved.src || '';
  }

  if (projectAssets?.length) {
    const asset = projectAssets.find((a) => {
      const aClean = a.slug ? stripSlugPrefix(a.slug) : a.slug;
      return a.slug === slug || a.slug === clean || aClean === clean;
    });
    if (asset) return asset.thumbnailSrc || asset.filePath || '';
  }

  return '';
}

function derivePlaceholderName(slugs: string[]): string {
  if (slugs.length === 0) return '';
  const first = stripSlugPrefix(slugs[0]);
  const withoutPrefix = first.replace(/^(img|vid)-/, '');
  const withoutTrailingNum = withoutPrefix.replace(/-\d+$/, '');
  return `element_${withoutTrailingNum.replace(/-/g, '_')}`;
}

export function ElementGroupEditor({
  elementGroupIndices,
  elementSchemas,
  formValues,
  resolvedAssets,
  droppedAssets,
  assets,
  onChange,
  disabled,
  domain = 'video',
}: ElementGroupEditorProps) {
  const skin = ELEMENT_SKINS[domain];
  const populatedCount = elementGroupIndices.reduce((count, idx) => {
    const slugs = formValues[`element${idx}_slugs`];
    const name = formValues[`element${idx}_name`];
    const desc = formValues[`element${idx}_desc`];
    const hasSlugs = Array.isArray(slugs) && slugs.length > 0;
    const hasName = typeof name === 'string' && name.length > 0;
    const hasDesc = typeof desc === 'string' && desc.length > 0;
    return hasSlugs || hasName || hasDesc ? count + 1 : count;
  }, 0);

  const [visibleCount, setVisibleCount] = useState(() => Math.max(populatedCount, 0));

  if (elementGroupIndices.length === 0) return null;

  const maxGroups = Math.min(elementGroupIndices.length, MAX_ELEMENT_GROUPS);
  const effectiveVisible = Math.max(visibleCount, populatedCount);
  const activeIndices = elementGroupIndices.slice(0, effectiveVisible);

  const handleAddGroup = () => {
    if (effectiveVisible < maxGroups) {
      setVisibleCount(effectiveVisible + 1);
    }
  };

  const handleRemoveGroup = (groupIdx: number) => {
    onChange(`element${groupIdx}_slugs`, []);
    onChange(`element${groupIdx}_name`, '');
    onChange(`element${groupIdx}_desc`, '');

    const currentIndices = elementGroupIndices.slice(0, effectiveVisible);
    const removePos = currentIndices.indexOf(groupIdx);
    if (removePos === -1) return;

    for (let pos = removePos; pos < currentIndices.length - 1; pos++) {
      const fromIdx = currentIndices[pos + 1];
      const toIdx = currentIndices[pos];
      const fromSlugs = formValues[`element${fromIdx}_slugs`];
      const fromName = formValues[`element${fromIdx}_name`];
      const fromDesc = formValues[`element${fromIdx}_desc`];
      onChange(`element${toIdx}_slugs`, fromSlugs ?? []);
      onChange(`element${toIdx}_name`, fromName ?? '');
      onChange(`element${toIdx}_desc`, fromDesc ?? '');
    }

    const lastIdx = currentIndices[currentIndices.length - 1];
    onChange(`element${lastIdx}_slugs`, []);
    onChange(`element${lastIdx}_name`, '');
    onChange(`element${lastIdx}_desc`, '');

    setVisibleCount(Math.max(effectiveVisible - 1, 0));
  };

  const handleSlotChange = (
    groupIdx: number,
    slotIndex: number,
    asset: { slug: string; src: string; type: 'image' | 'video' | 'audio' | 'character' } | null,
    droppedAsset?: ResolvedAsset
  ) => {
    const slugsKey = `element${groupIdx}_slugs`;
    const currentSlugs: string[] = Array.isArray(formValues[slugsKey])
      ? (formValues[slugsKey] as string[]).filter(Boolean)
      : [];
    const newValues = [...currentSlugs];

    if (asset) {
      if (newValues.includes(asset.slug)) return;
      if (slotIndex < newValues.length) {
        newValues[slotIndex] = asset.slug;
      } else {
        newValues.push(asset.slug);
      }
      onChange(slugsKey, newValues, droppedAsset);
    } else {
      newValues.splice(slotIndex, 1);
      onChange(slugsKey, newValues);
    }
  };

  return (
    <GenSection
      label="elements"
      color={domain}
      rightSlot={
        <span className={cn('text-[10px] font-mono', skin.countText)}>
          {effectiveVisible}/{maxGroups}
        </span>
      }
      bodyClassName="px-2.5 py-2.5 space-y-2.5"
    >
      {activeIndices.map((groupIdx) => {
        const slugsSchema = elementSchemas.get(`element${groupIdx}_slugs`);
        const maxItems = slugsSchema?.maxItems ?? 4;
        const currentSlugs: string[] = Array.isArray(formValues[`element${groupIdx}_slugs`])
          ? (formValues[`element${groupIdx}_slugs`] as string[]).filter(Boolean)
          : [];
        const currentName = (formValues[`element${groupIdx}_name`] as string) || '';
        const currentDesc = (formValues[`element${groupIdx}_desc`] as string) || '';
        const hasSlugs = currentSlugs.length > 0;
        const filledCount = currentSlugs.length;
        const canAddMore = filledCount < maxItems;

        const slots: Array<{ slug: string | null; index: number }> = [];
        currentSlugs.forEach((slug, idx) => slots.push({ slug, index: idx }));
        if (canAddMore) slots.push({ slug: null, index: filledCount });

        return (
          <div key={groupIdx} className={cn('border rounded p-2.5 space-y-2.5', skin.cardBorder, skin.cardBg)}>
            {/* Header */}
            <div className="flex items-center justify-between">
              <span className={cn('text-[10px] font-bold tracking-[0.15em] uppercase', skin.labelText)}>
                Element {groupIdx}
              </span>
              <div className="flex items-center gap-2">
                <span className={cn('text-[10px] font-mono', skin.countText)}>
                  {filledCount}/{maxItems}
                </span>
                <button
                  type="button"
                  onClick={() => handleRemoveGroup(groupIdx)}
                  disabled={disabled}
                  className={cn(
                    'w-5 h-5 flex items-center justify-center rounded',
                    'text-red-400/60 hover:text-red-400 hover:bg-red-400/10',
                    'transition-colors duration-150',
                    'focus-visible:ring-1 focus-visible:ring-red-400/60 focus-visible:outline-none',
                    disabled && 'opacity-50 cursor-not-allowed'
                  )}
                  aria-label={`Remove element ${groupIdx}`}
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Asset drop slots */}
            <div className="flex flex-col gap-2">
              {slots.map(({ slug, index }) => {
                const thumbnailSrc = slug ? findThumbnail(slug, droppedAssets, resolvedAssets, assets) : '';
                return (
                  <div key={`el${groupIdx}-${index}`}>
                    <AssetDropSlot
                      value={slug ? { slug, src: thumbnailSrc, type: 'image' as const } : null}
                      onChange={(asset) => {
                        if (asset) {
                          const resolved: ResolvedAsset = {
                            slug: asset.slug,
                            src: asset.src,
                            type: asset.type,
                          };
                          handleSlotChange(groupIdx, index, asset, resolved);
                        } else {
                          handleSlotChange(groupIdx, index, null);
                        }
                      }}
                      disabled={disabled}
                      acceptTypes={['image', 'video']}
                      emptyIcon={<Puzzle className="w-5 h-5" />}
                      variant={skin.slotVariant}
                    />
                  </div>
                );
              })}
            </div>

            {/* Name input */}
            {(hasSlugs || currentName || currentDesc) && (
              <input
                type="text"
                value={currentName}
                onChange={(e) => onChange(`element${groupIdx}_name`, e.target.value)}
                placeholder={derivePlaceholderName(currentSlugs)}
                disabled={disabled}
                aria-label={`Element ${groupIdx} name`}
                className={cn(
                  'w-full px-3 py-1.5',
                  'bg-black/60 border rounded',
                  skin.inputBorder,
                  skin.inputText,
                  skin.inputPlaceholder,
                  'font-mono text-xs',
                  'focus:outline-none',
                  skin.inputFocus,
                  'transition-all duration-200',
                  disabled && 'opacity-50 cursor-not-allowed'
                )}
              />
            )}

            {/* Description input */}
            {(hasSlugs || currentName || currentDesc) && (
              <div className="space-y-1">
                <div className="flex items-center gap-2">
                  <span className={cn('text-[10px] font-bold tracking-[0.15em] uppercase', skin.labelText)}>desc</span>
                  <span className="text-[8px] font-bold text-red-400/80 tracking-wider">*REQ</span>
                </div>
                <textarea
                  value={currentDesc}
                  onChange={(e) => onChange(`element${groupIdx}_desc`, e.target.value)}
                  placeholder={`Describe element ${groupIdx}...`}
                  disabled={disabled}
                  rows={2}
                  maxLength={100}
                  aria-label={`Element ${groupIdx} description`}
                  className={cn(
                    'w-full px-3 py-2 resize-none',
                    'bg-black/60 border rounded',
                    skin.inputBorder,
                    skin.inputText,
                    skin.inputPlaceholder,
                    'font-mono text-xs leading-relaxed',
                    'focus:outline-none',
                    skin.inputFocus,
                    'transition-all duration-200',
                    disabled && 'opacity-50 cursor-not-allowed'
                  )}
                />
                <div className={cn('text-right text-[9px] font-mono mt-0.5', skin.charCount)}>
                  {currentDesc.length}/100
                </div>
              </div>
            )}
          </div>
        );
      })}

      {/* Add element button */}
      {effectiveVisible < maxGroups && (
        <button
          type="button"
          onClick={handleAddGroup}
          disabled={disabled}
          className={cn(
            'w-full h-8 flex items-center justify-center gap-1.5 rounded',
            'border border-dashed',
            skin.addBorder,
            'text-[10px] font-bold tracking-[0.15em] uppercase',
            skin.addText,
            skin.addHover,
            'transition-all duration-200',
            'focus-visible:ring-1 focus-visible:outline-none',
            skin.addFocus,
            disabled && 'opacity-50 cursor-not-allowed'
          )}
        >
          <Plus className="w-3 h-3" />
          <span>/elements add</span>
        </button>
      )}
    </GenSection>
  );
}
