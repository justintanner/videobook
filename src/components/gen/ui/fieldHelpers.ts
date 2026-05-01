import type { JSONSchemaProperty } from '../types';
import { ELEMENT_FIELD_RE } from '../types';

/** Determine if a field should go in the right column (asset fields) */
export function isAssetField(name: string): boolean {
  return (
    name === 'image_slugs'
    || name === 'image_slug'
    || name === 'video_slug'
    || name === 'video_slugs'
    || name === 'first_frame_slug'
    || name === 'last_frame_slug'
    || name === 'first_clip_slug'
    || name === 'driving_audio_slug'
    || name === 'audio_slug'
    || name === 'character_image_slugs'
    || name === 'motion_video_slugs'
  );
}

/** Return the accepted asset type for a slug field name */
export function slugFieldAssetType(name: string): 'image' | 'video' | 'audio' {
  if (
    name === 'video_slug'
    || name === 'video_slugs'
    || name === 'first_clip_slug'
    || name === 'motion_video_slugs'
  ) return 'video';
  if (name === 'audio_slug' || name === 'driving_audio_slug') return 'audio';
  return 'image';
}

/** Determine if a field is an element field (element1_slugs, element2_name, etc.) */
export function isElementField(name: string): boolean {
  return ELEMENT_FIELD_RE.test(name);
}

/** Sort fields: prompt first, then alphabetically, asset fields last */
export function sortFields(fields: [string, JSONSchemaProperty][]): [string, JSONSchemaProperty][] {
  return [...fields].sort(([aName], [bName]) => {
    if (aName === 'prompt') return -1;
    if (bName === 'prompt') return 1;

    const aIsSidebar = isAssetField(aName);
    const bIsSidebar = isAssetField(bName);
    if (aIsSidebar && !bIsSidebar) return 1;
    if (!aIsSidebar && bIsSidebar) return -1;

    // Preserve schema-defined order for asset fields (e.g. first-frame before driving-audio)
    if (aIsSidebar && bIsSidebar) return 0;
    return aName.localeCompare(bName);
  });
}
