import { describe, it, expect } from 'vitest';
import { buildResultTiles, type ResultGhost } from './resultTiles';
import type { MediaItem } from '@/components/sidebar/types';

function clip(over: Partial<MediaItem> & { id: string }): MediaItem {
  return {
    type: 'video',
    slug: `@vid-${over.id}`,
    title: over.id,
    filePath: `/files/p/${over.id}/original.mp4`,
    ...over,
  } as MediaItem;
}

describe('buildResultTiles', () => {
  it('lists ghosts first, then video clips newest-first', () => {
    const clips: MediaItem[] = [
      clip({ id: 'a', createdAt: '2026-01-01T00:00:00Z' }),
      clip({ id: 'c', createdAt: '2026-03-01T00:00:00Z' }),
      clip({ id: 'b', createdAt: '2026-02-01T00:00:00Z' }),
    ];
    const ghosts: ResultGhost[] = [{ requestId: 'g1', prompt: 'pending one', startedAt: 1 }];
    const tiles = buildResultTiles(clips, ghosts);
    expect(tiles.map((t) => t.id)).toEqual(['g1', 'c', 'b', 'a']);
    expect(tiles[0].pending).toBe(true);
  });

  it('excludes non-video clips (e.g. finals)', () => {
    const clips: MediaItem[] = [
      clip({ id: 'v', createdAt: '2026-01-02T00:00:00Z' }),
      { ...clip({ id: 'f', createdAt: '2026-01-03T00:00:00Z' }), type: 'final' } as MediaItem,
    ];
    const tiles = buildResultTiles(clips, []);
    expect(tiles.map((t) => t.id)).toEqual(['v']);
  });

  it('flags pending and failed clips', () => {
    const clips: MediaItem[] = [
      clip({ id: 'ready', status: 'ready', createdAt: '2026-01-03T00:00:00Z' }),
      clip({ id: 'gen', status: 'generating', createdAt: '2026-01-02T00:00:00Z' }),
      clip({ id: 'err', status: 'error', createdAt: '2026-01-01T00:00:00Z' }),
    ];
    const byId = Object.fromEntries(buildResultTiles(clips, []).map((t) => [t.id, t]));
    expect(byId.ready.pending).toBe(false);
    expect(byId.ready.failed).toBe(false);
    expect(byId.gen.pending).toBe(true);
    expect(byId.err.failed).toBe(true);
  });

  it('falls back to an original.jpg thumbnail when none is set', () => {
    const [tile] = buildResultTiles([clip({ id: 'a', createdAt: '2026-01-01T00:00:00Z' })], []);
    expect(tile.thumbSrc).toBe('/files/p/a/original.jpg');
    expect(tile.videoSrc).toBe('/files/p/a/original.mp4');
  });

  it('prefers an explicit thumbnailSrc', () => {
    const [tile] = buildResultTiles(
      [clip({ id: 'a', thumbnailSrc: '/thumb.png', createdAt: '2026-01-01T00:00:00Z' })],
      [],
    );
    expect(tile.thumbSrc).toBe('/thumb.png');
  });

  it('caps the tile count at the limit (ghosts + newest clips)', () => {
    const clips: MediaItem[] = Array.from({ length: 20 }, (_, i) =>
      clip({ id: `c${i}`, createdAt: `2026-01-${String(i + 1).padStart(2, '0')}T00:00:00Z` }),
    );
    const tiles = buildResultTiles(clips, [], 5);
    expect(tiles).toHaveLength(5);
  });
});
