import type { MediaItem } from '@/components/sidebar/types';

// Auto-selection for the marketplace "Use Template" CTA: the preview no longer
// shows a config form, so a template picks the project's newest matching assets
// (by id prefix) and generates from those. Editing in the Customize expander
// overrides these seeds.

// Statuses that make an asset unusable as a plan input.
const UNUSABLE_STATUSES = new Set<string>(['error', 'deleting']);

function isUsable(item: MediaItem): boolean {
  return !item.archivedAt && !(item.status != null && UNUSABLE_STATUSES.has(item.status));
}

// Newest-first (by createdAt) ids whose id starts with any of the given prefixes,
// skipping archived/errored assets. `limit` caps the count when provided.
export function newestIdsByPrefix(items: MediaItem[], prefix: string | string[], limit?: number): string[] {
  const prefixes = Array.isArray(prefix) ? prefix : [prefix];
  const matching = items.filter((m) => isUsable(m) && prefixes.some((p) => m.id.startsWith(p)));
  const sorted = [...matching].sort(byNewest);
  const ids = sorted.map((m) => m.id);
  return limit != null ? ids.slice(0, limit) : ids;
}

function byNewest(a: MediaItem, b: MediaItem): number {
  const at = a.createdAt ? Date.parse(a.createdAt) : NaN;
  const bt = b.createdAt ? Date.parse(b.createdAt) : NaN;
  if (Number.isNaN(at) && Number.isNaN(bt)) return 0;
  if (Number.isNaN(at)) return 1;
  if (Number.isNaN(bt)) return -1;
  return bt - at;
}

// Per-formula seeds. Each mirrors the inputs its setup panel needs.

export function autoPickClipShow(mediaItems: MediaItem[]): { characterId: string; imageAssetIds: string[] } {
  // Prefer a host that already has an ElevenLabs voice (Clip Show needs one);
  // fall back to the newest char so the panel still pre-fills and the disabled
  // hint / server pre-check can explain the missing voice.
  const voiced = mediaItems.filter((m) => m.hasVoice === true);
  const characterId =
    newestIdsByPrefix(voiced, 'char-', 1)[0] ?? newestIdsByPrefix(mediaItems, 'char-', 1)[0] ?? '';
  // Seed the newest images as the joke pool (no images → empty; user adds more
  // in Customize). The model groups them into jokes and lays out OSG runs.
  const imageAssetIds = newestIdsByPrefix(mediaItems, 'img-', 6);
  return { characterId, imageAssetIds };
}

export function autoPickStoryboard(items: MediaItem[]): { sourceImageIds: string[] } {
  return { sourceImageIds: newestIdsByPrefix(items, 'img-', 1) };
}

export function autoPickCharSwap(items: MediaItem[]): { sourceId: string | null; charAId: string | null; charBId: string | null } {
  const subjects = newestIdsByPrefix(items, ['char-', 'img-'], 2);
  return {
    sourceId: newestIdsByPrefix(items, 'vid-', 1)[0] ?? null,
    charAId: subjects[0] ?? null,
    charBId: subjects[1] ?? null,
  };
}
