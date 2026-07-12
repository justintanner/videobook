/** Short character names derived from image/char asset slugs (Google Flow display_name). */

const MIN_STEM_LEN = 3;

/** Strip @ and normalize to bare asset id. */
export function bareAssetId(slug: string): string {
  return slug.startsWith("@") ? slug.slice(1) : slug;
}

/**
 * Stem suitable for a short character name.
 * img-french-head → french-head
 * char-img-french-head → french-head
 * char-french-head → french-head
 * img-n → "" (degenerate)
 */
export function characterNameStem(slugOrId: string): string {
  let s = bareAssetId(slugOrId).trim();
  if (s.startsWith("char-")) s = s.slice("char-".length);
  if (s.startsWith("img-")) s = s.slice("img-".length);
  s = s.trim();
  return s.length >= MIN_STEM_LEN ? s : "";
}

/** Asset create name + display_name: stem or fallback. */
export function resolveCharacterCreateName(
  explicitNameParts: string[],
  imageSources: string[],
): string {
  if (explicitNameParts.length > 0) {
    return explicitNameParts.join("-");
  }
  const fromImage = imageSources[0] ? characterNameStem(imageSources[0]) : "";
  return fromImage || "character";
}
