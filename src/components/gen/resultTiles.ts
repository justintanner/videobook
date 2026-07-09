import type { MediaItem } from '@/components/sidebar/types';

/** In-flight generation placeholder, structurally assignable from HomePage's
 *  ghostClips entries. */
export interface ResultGhost {
  requestId: string;
  assetId?: string;
  prompt: string;
  startedAt: number;
}

export interface ResultTile {
  id: string;
  slug: string;
  title: string;
  /** Playable video URL (empty for ghosts). */
  videoSrc: string;
  thumbSrc: string | null;
  duration: number | null;
  pending: boolean;
  failed: boolean;
  prompt: string | null;
}

function isPending(item: MediaItem): boolean {
  if (item.pendingState === 'queued' || item.pendingState === 'processing') return true;
  const status = item.status;
  return status != null && status !== 'ready' && status !== 'error';
}

function thumbFor(item: MediaItem): string | null {
  if (item.thumbnailSrc) return item.thumbnailSrc;
  if (item.filePath) return item.filePath.replace(/\/[^/]+$/, '/original.jpg');
  return null;
}

/** Ghosts first (newest, just submitted), then ready/pending video clips
 *  newest-first, capped at `limit`. Pure — unit-tested. */
export function buildResultTiles(
  clips: MediaItem[],
  ghosts: ResultGhost[],
  limit = 12,
): ResultTile[] {
  const ghostTiles: ResultTile[] = ghosts.map((g) => ({
    id: g.assetId ?? g.requestId,
    slug: '',
    title: g.prompt || 'Generating…',
    videoSrc: '',
    thumbSrc: null,
    duration: null,
    pending: true,
    failed: false,
    prompt: g.prompt,
  }));

  const clipTiles: ResultTile[] = clips
    .filter((c) => c.type === 'video')
    .slice()
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .map((item) => ({
      id: item.id,
      slug: item.slug,
      title: item.title,
      videoSrc: item.filePath,
      thumbSrc: thumbFor(item),
      duration: item.duration ?? null,
      pending: isPending(item),
      failed: item.status === 'error' || item.pendingState === 'fail',
      prompt: item.prompt ?? null,
    }));

  return [...ghostTiles, ...clipTiles].slice(0, limit);
}
