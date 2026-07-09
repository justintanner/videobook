import type { ModelOption, ModeSpec } from '@/components/gen/types';
import { isAssetField } from '@/components/gen/ui/fieldHelpers';

const IMGS_SUFFIX = /-imgs:(\d+)$/;

/** Character entity with an optional image count (from list_google_flow_characters
 *  imageReferences), used to size the ×N badge and budget fallback. */
export interface CharacterEntity {
  image_count?: number | null;
}

/** Reference images contributed by a character ref. A useapi.net `-imgs:N`
 *  suffix wins (clamped 1..2); otherwise the entity's image_count; else 1. */
export function characterImageCount(ref: string, entity?: CharacterEntity | null): number {
  const match = IMGS_SUFFIX.exec(ref);
  if (match) {
    const n = Number.parseInt(match[1], 10);
    if (Number.isFinite(n)) return Math.min(2, Math.max(1, n));
  }
  if (entity?.image_count != null && Number.isFinite(entity.image_count)) {
    return Math.min(2, Math.max(1, Math.trunc(entity.image_count)));
  }
  return 1;
}

export interface RefBudget {
  /** image_slugs + per-character image counts. */
  used: number;
  /** 5 alongside a reference clip (edit), else 7. */
  max: number;
  /** true when used > max — mirrors the server A4 rule and blocks Generate. */
  blocking: boolean;
  /** meter text, e.g. "refs · 3/7" or "edit · 2/5". */
  meter: string;
  /** human message when over budget (mirrors server text). */
  message?: string;
}

/** Combined omni reference-image budget. Returns the used/max meter plus a
 *  blocking flag when image_slugs + character images exceed the limit. The
 *  `max` tightens to 5 in the edit (V2V) mode. */
export function combinedRefBudget(
  values: Record<string, unknown>,
  characterRefs: string[],
  mode: ModeSpec | null,
  entities?: Record<string, CharacterEntity | null>,
): RefBudget {
  const imageCount = Array.isArray(values.image_slugs) ? values.image_slugs.length : 0;
  const charTotal = characterRefs.reduce((sum, ref) => {
    const e = entities?.[ref];
    return sum + characterImageCount(ref, e);
  }, 0);
  const used = imageCount + charTotal;
  const max = mode?.key === 'edit' ? 5 : 7;
  const blocking = used > max;
  const meter = `${mode?.label?.toLowerCase() ?? 'refs'} · ${used}/${max}`;
  const message = blocking
    ? `Reference budget exceeded: ${used}/${max} images (characters with two images count twice). Remove an image or character.`
    : undefined;
  return { used, max, blocking, meter, message };
}

export interface StripSlot {
  param: string;
  kind: 'image' | 'video' | 'audio';
  label: string;
  max: number | null;
}

/** The media strip's slots: for a moded model, the union of every mode's asset
 *  slots (deduped by param); for a flat model, the schema's asset fields. */
export function deriveStripSlots(option: Pick<ModelOption, 'modes' | 'schema'>): StripSlot[] {
  if (option.modes) {
    const seen = new Set<string>();
    const out: StripSlot[] = [];
    for (const mode of option.modes.modes) {
      for (const slot of mode.asset_slots ?? []) {
        if (seen.has(slot.param)) continue;
        seen.add(slot.param);
        out.push({ param: slot.param, kind: slot.kind, label: slot.label, max: slot.max ?? null });
      }
    }
    return out;
  }
  const out: StripSlot[] = [];
  for (const [name] of Object.entries(option.schema.properties)) {
    if (isAssetField(name)) {
      const kind: StripSlot['kind'] = name.startsWith('video') ? 'video' : name.startsWith('audio') ? 'audio' : 'image';
      out.push({ param: name, kind, label: name.replace(/_slugs?$/, '').replace(/_/g, ' '), max: null });
    }
  }
  return out;
}

export interface DropRoute {
  param: string;
  action: 'set' | 'append';
}

/** Route a dropped asset to the right slot. video → the video slot (set);
 *  audio → the first audio slot (set); image → append image_slugs when present,
 *  else set the first single-image slot. */
export function routeDrop(
  kind: 'image' | 'video' | 'audio',
  slots: StripSlot[],
): DropRoute {
  if (kind === 'video') {
    const v = slots.find((s) => s.kind === 'video');
    return { param: v?.param ?? 'video_slug', action: 'set' };
  }
  if (kind === 'audio') {
    const a = slots.find((s) => s.kind === 'audio');
    return { param: a?.param ?? '', action: 'set' };
  }
  const imageSlugs = slots.find((s) => s.param === 'image_slugs');
  if (imageSlugs) return { param: 'image_slugs', action: 'append' };
  const firstImage = slots.find((s) => s.kind === 'image');
  return { param: firstImage?.param ?? '', action: 'set' };
}

/** Append a slug to image_slugs (deduped); returns the new array. */
export function appendImageSlug(values: Record<string, unknown>, slug: string): string[] {
  const current = Array.isArray(values.image_slugs) ? (values.image_slugs as string[]) : [];
  const clean = slug.startsWith('@') ? slug : `@${slug}`;
  if (current.some((s) => s === clean || s === slug)) return current;
  return [...current, clean];
}

/** Toggle the first-frame pin. Pinning an image moves it from image_slugs into
 *  first_frame_slug; pinning another swaps. Unpinning restores it to image_slugs. */
export function toggleFirstFramePin(
  values: Record<string, unknown>,
  slug: string,
): { image_slugs?: string[]; first_frame_slug?: string } {
  const clean = slug.startsWith('@') ? slug : `@${slug}`;
  const currentFirst = typeof values.first_frame_slug === 'string' ? values.first_frame_slug : '';
  if (currentFirst === clean) {
    // unpin → move back into image_slugs
    const imgs = Array.isArray(values.image_slugs) ? (values.image_slugs as string[]) : [];
    return { first_frame_slug: '', image_slugs: [clean, ...imgs] };
  }
  const imgs = Array.isArray(values.image_slugs) ? (values.image_slugs as string[]) : [];
  const without = imgs.filter((s) => s !== clean);
  const restored = currentFirst ? [currentFirst, ...without] : without;
  return { first_frame_slug: clean, image_slugs: restored };
}
