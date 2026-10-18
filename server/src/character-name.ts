
const MIN_STEM_LEN = 3;

/** Strip @ and normalize to bare asset id. */
export function bareAssetId(reference: string): string {
  return reference.startsWith("@") ? reference.slice(1) : reference;
}

/**
 * Stem suitable for a short character name. Artifact ids are opaque UUIDs, so
 * the stem comes from the source artifact's free-text label.
 * "french-head" → french-head
 * "French Head" → French Head
 * "n" → "" (degenerate)
 * "" (unlabelled artifact) → ""
 */
export function characterNameStem(label: string): string {
  const stem = label.trim();
  return stem.length >= MIN_STEM_LEN ? stem : "";
}

/** Asset create name + display_name: stem or fallback. */
export function resolveCharacterCreateName(
  explicitNameParts: string[],
  imageLabels: string[],
): string {
  if (explicitNameParts.length > 0) {
    return explicitNameParts.join("-");
  }
  const fromImage = imageLabels[0] ? characterNameStem(imageLabels[0]) : "";
  return fromImage || "character";
}
