import type { ModelOption, ModeSpec } from '@/components/gen/types';
import { isAssetField, slugFieldAssetType } from '@/components/gen/ui/fieldHelpers';

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
  /** per-model cap (active-mode image_slugs slot max, else validation cap),
   *  or null for a count-only meter that never blocks. */
  max: number | null;
  /** true when max is set and used > max — mirrors the server A4 rule. */
  blocking: boolean;
  /** meter text, e.g. "refs · 3/7", or count-only "refs · 2" when unbounded. */
  meter: string;
  /** human message when over budget (mirrors server text). */
  message?: string;
}

/** Per-model reference-image cap. The active mode's `image_slugs` asset-slot
 *  max wins (omni r2v 7, edit 5); else the server-shipped
 *  `validation.image_slots.max` (Nano Banana Pro 10, omni t2v/i2v 7 via
 *  IMAGE_SLOT_OVERRIDES, Grok 1, …); else null (count-only, non-blocking). */
export function imageRefMax(
  option: Pick<ModelOption, 'modes' | 'validation'>,
  mode: ModeSpec | null,
): number | null {
  if (mode?.asset_slots) {
    const slot = mode.asset_slots.find((s) => s.param === 'image_slugs');
    if (slot?.max != null) return slot.max;
  }
  if (option.validation?.image_slots?.max != null) {
    return option.validation.image_slots.max;
  }
  return null;
}

/** Combined reference-image budget. Returns the used/max meter plus a blocking
 *  flag when image_slugs + character images exceed `max`. `max` is sourced from
 *  imageRefMax; null makes the meter count-only and never blocking. Character
 *  image counting stays (nonzero only for video). */
export function combinedRefBudget(
  values: Record<string, unknown>,
  characterRefs: string[],
  mode: ModeSpec | null,
  max: number | null,
  entities?: Record<string, CharacterEntity | null>,
): RefBudget {
  const imageCount = Array.isArray(values.image_slugs) ? values.image_slugs.length : 0;
  const charTotal = characterRefs.reduce((sum, ref) => {
    const e = entities?.[ref];
    return sum + characterImageCount(ref, e);
  }, 0);
  const used = imageCount + charTotal;
  const blocking = max != null && used > max;
  const meter = max != null
    ? `${mode?.label?.toLowerCase() ?? 'refs'} · ${used}/${max}`
    : `${mode?.label?.toLowerCase() ?? 'refs'} · ${used}`;
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

/** The media strip's slots.
 *  - When `activeMode` is provided for a moded model: only that mode's asset_slots
 *    (so explicit /type selection gates which chips/drops are available).
 *  - When no active mode on a moded model: union of every mode's asset slots
 *    (deduped by param) — legacy fallback.
 *  - Flat models: schema asset fields. */
export function deriveStripSlots(
  option: Pick<ModelOption, 'modes' | 'schema'>,
  activeMode?: ModeSpec | null,
): StripSlot[] {
  if (option.modes) {
    if (activeMode) {
      return (activeMode.asset_slots ?? []).map((slot) => ({
        param: slot.param,
        kind: slot.kind,
        label: slot.label,
        max: slot.max ?? null,
      }));
    }
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
      const kind: StripSlot['kind'] = slugFieldAssetType(name);
      out.push({ param: name, kind, label: name.replace(/_slugs?$/, '').replace(/_/g, ' '), max: null });
    }
  }
  return out;
}

export interface DropRoute {
  param: string;
  action: 'set' | 'append';
}

/** Params that hold multiple @slugs (append on drop). Everything else is set. */
const ARRAY_SLUG_PARAMS = new Set([
  'image_slugs',
  'video_slugs',
  'audio_slugs',
  'character_image_slugs',
  'motion_video_slugs',
]);

export function isArraySlugParam(param: string): boolean {
  return ARRAY_SLUG_PARAMS.has(param) || param.endsWith('_slugs');
}

/** Route a dropped asset to the right slot. Array slug params (image_slugs,
 *  video_slugs, audio_slugs, …) append; single-slug slots (video_slug,
 *  first_frame_slug, …) set. Empty `param` means no matching slot (e.g. mode
 *  is text-only) — callers should fall back to all-mode slots or reject. */
export function routeDrop(
  kind: 'image' | 'video' | 'audio' | 'character',
  slots: StripSlot[],
): DropRoute {
  if (kind === 'character') {
    const charSlot = slots.find((s) => s.param === 'character_image_slugs');
    if (charSlot) return { param: charSlot.param, action: isArraySlugParam(charSlot.param) ? 'append' : 'set' };
    return { param: '', action: 'set' };
  }
  if (kind === 'video') {
    const v = slots.find((s) => s.kind === 'video');
    if (!v) return { param: '', action: 'set' };
    return { param: v.param, action: isArraySlugParam(v.param) ? 'append' : 'set' };
  }
  if (kind === 'audio') {
    const a = slots.find((s) => s.kind === 'audio');
    if (!a) return { param: '', action: 'set' };
    return { param: a.param, action: isArraySlugParam(a.param) ? 'append' : 'set' };
  }
  const imageSlugs = slots.find((s) => s.param === 'image_slugs');
  if (imageSlugs) return { param: 'image_slugs', action: 'append' };
  const firstImage = slots.find((s) => s.kind === 'image');
  if (!firstImage) return { param: '', action: 'set' };
  return {
    param: firstImage.param,
    action: isArraySlugParam(firstImage.param) ? 'append' : 'set',
  };
}

/** Append a slug to any array slug param (deduped); returns the new array.
 *  When `max` is set and the array is already full, returns the current array. */
export function appendSlug(
  values: Record<string, unknown>,
  param: string,
  slug: string,
  max?: number | null,
): string[] {
  const current = Array.isArray(values[param]) ? (values[param] as string[]) : [];
  const clean = slug.startsWith('@') ? slug : `@${slug}`;
  if (current.some((s) => s === clean || s === slug)) return current;
  if (max != null && current.length >= max) return current;
  return [...current, clean];
}

/** Append a slug to image_slugs (deduped); returns the new array. */
export function appendImageSlug(values: Record<string, unknown>, slug: string): string[] {
  return appendSlug(values, 'image_slugs', slug);
}

/** Resolve which array/set param a project asset slug should wire into. */
export function paramForAssetSlug(
  slug: string,
  slots: StripSlot[],
): DropRoute | null {
  const clean = slug.startsWith('@') ? slug.slice(1) : slug;
  const kind: StripSlot['kind'] | 'character' =
    clean.startsWith('char-') ? 'character' : clean.startsWith('vid-') ? 'video' : clean.startsWith('aud-') ? 'audio' : 'image';
  if (kind === 'character') {
    const charSlot = slots.find((s) => s.param === 'character_image_slugs');
    if (!charSlot) return null;
    return routeDrop('character', slots);
  }
  if (!slots.some((s) => s.kind === kind)) return null;
  return routeDrop(kind, slots);
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
