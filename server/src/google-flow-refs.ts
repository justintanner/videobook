// Omni Flash reference-image budget math. A character ref may carry a trailing
// `-imgs:N` suffix minted by useapi.net indicating how many reference images it
// contributes (1 or 2); suffix-less refs contribute one. Image refs (image_slugs)
// each contribute one. The combined total must not exceed 7 (useapi.net R2V
// budget), or 5 alongside a reference clip (V2V).

const IMGS_SUFFIX = /-imgs:(\d+)$/;

/** Strip the `-imgs:N` suffix from a character ref to get its canonical ID. */
export function canonicalCharacterId(ref: string): string {
  return ref.replace(IMGS_SUFFIX, "");
}

/** Parse the useapi.net `-imgs:N` suffix on a character ref. Absent or
 *  malformed → 1; clamped to 1..2. */
export function characterRefImageCount(ref: string): number {
  const match = IMGS_SUFFIX.exec(ref);
  if (!match) return 1;
  const n = Number.parseInt(match[1], 10);
  if (!Number.isFinite(n)) return 1;
  return Math.min(2, Math.max(1, n));
}

/** Total reference images for an omni-flash R2V request: image refs plus the
 *  per-character image counts. */
export function totalOmniReferenceImages(imageCount: number, characterRefs: string[]): number {
  const charImages = characterRefs.reduce(
    (sum, ref) => sum + characterRefImageCount(ref),
    0,
  );
  return imageCount + charImages;
}

export const OMNI_MAX_REFERENCE_IMAGES = 7;
export const OMNI_V2V_MAX_REFERENCE_IMAGES = 5;
