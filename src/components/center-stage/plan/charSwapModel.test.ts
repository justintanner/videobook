import { describe, it, expect } from 'vitest';
import type { MediaItem } from '@/components/sidebar/types';
import { deriveVideoTileState, type PlanScene } from './charSwapModel';

const PROJECT = 'proj';

function scene(video: string | null): PlanScene {
  return { start: 0, end: 5, visual: '', swap: { image1: null, image2: null, video } };
}

function vid(id: string, status: MediaItem['status'], failedMessage?: string): MediaItem {
  return { id, type: 'video', slug: `@${id}`, title: id, filePath: '', status, failedMessage };
}

describe('deriveVideoTileState', () => {
  it('is idle when the scene has no linked video', () => {
    expect(deriveVideoTileState(scene(null), [], PROJECT)).toEqual({ kind: 'idle' });
  });

  it('reflects a ready asset with its media src', () => {
    const tile = deriveVideoTileState(scene('vid-x'), [vid('vid-x', 'ready')], PROJECT);
    expect(tile).toEqual({ kind: 'ready', src: `/files/${PROJECT}/vid-x/original.mp4` });
  });

  it('reflects an errored asset with its failure message', () => {
    const tile = deriveVideoTileState(scene('vid-x'), [vid('vid-x', 'error', 'boom')], PROJECT);
    expect(tile).toEqual({ kind: 'error', message: 'boom' });
  });

  it('shows generating while a linked asset is still working', () => {
    const tile = deriveVideoTileState(scene('vid-x'), [vid('vid-x', 'generating')], PROJECT);
    expect(tile.kind).toBe('generating');
  });

  // Regression: a dangling scene.swap.video link (asset deleted, or its creation
  // rolled back after a failed/timed-out gen) must NOT spin forever.
  it('falls back to idle for a dangling link when no submit is in flight', () => {
    expect(deriveVideoTileState(scene('vid-gone'), [], PROJECT)).toEqual({ kind: 'idle' });
    expect(deriveVideoTileState(scene('vid-gone'), [], PROJECT, false)).toEqual({ kind: 'idle' });
  });

  it('shows generating for a not-yet-listed asset while a submit is in flight', () => {
    expect(deriveVideoTileState(scene('vid-new'), [], PROJECT, true)).toEqual({ kind: 'generating' });
  });
});
