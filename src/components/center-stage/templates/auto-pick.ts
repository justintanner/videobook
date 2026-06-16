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

// A Clip Show item the host jokes about: a text topic or an img-* image. Mirrors
// the union in PlanViewer/plan-types (kept local to avoid a client import cycle).
export type ClipShowItem =
  | { kind: 'topic'; topic: string }
  | { kind: 'image'; image_asset_id: string };

export function autoPickClipShow(mediaItems: MediaItem[]): { characterId: string; items: ClipShowItem[] } {
  // Prefer a host that already has an ElevenLabs voice (Clip Show needs one);
  // fall back to the newest char so the panel still pre-fills and the disabled
  // hint / server pre-check can explain the missing voice.
  const voiced = mediaItems.filter((m) => m.hasVoice === true);
  const characterId =
    newestIdsByPrefix(voiced, 'char-', 1)[0] ?? newestIdsByPrefix(mediaItems, 'char-', 1)[0] ?? '';
  // Seed the newest images as items (no images → empty; user adds topics/images
  // in Customize). Topics can't be auto-invented.
  const items: ClipShowItem[] = newestIdsByPrefix(mediaItems, 'img-', 6).map((id) => ({
    kind: 'image',
    image_asset_id: id,
  }));
  return { characterId, items };
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
