import { describe, expect, it } from 'vitest';
import type { ModelOption, ModelModes } from '@/components/gen/types';
import {
  appendImageSlug,
  characterImageCount,
  combinedRefBudget,
  deriveStripSlots,
  routeDrop,
  toggleFirstFramePin,
} from '@/components/gen/ui/media-strip';

const omniModes: ModelModes = {
  shared_params: ['prompt', 'duration', 'aspect_ratio'],
  default_mode: 't2v',
  modes: [
    { key: 't2v', label: 'text', params: [] },
    { key: 'i2v', label: 'first frame', params: ['first_frame_slug'], asset_slots: [{ param: 'first_frame_slug', kind: 'image', label: 'first frame' }] },
    { key: 'r2v', label: 'refs', params: ['image_slugs', 'character_refs'], asset_slots: [{ param: 'image_slugs', kind: 'image', label: 'references', max: 7 }, { param: 'character_refs', kind: 'image', label: 'characters', max: 7 }] },
    { key: 'edit', label: 'edit', params: ['video_slug', 'image_slugs', 'character_refs'], asset_slots: [{ param: 'video_slug', kind: 'video', label: 'clip' }, { param: 'image_slugs', kind: 'image', label: 'references', max: 5 }] },
  ],
};

describe('characterImageCount', () => {
  it('parses -imgs:2', () => {
    expect(characterImageCount('character:a-imgs:2')).toBe(2);
  });
  it('defaults a bare ref to 1', () => {
    expect(characterImageCount('character:a')).toBe(1);
  });
  it('clamps -imgs:9 to 2', () => {
    expect(characterImageCount('character:a-imgs:9')).toBe(2);
  });
  it('falls back to entity.image_count without a suffix', () => {
    expect(characterImageCount('character:a', { image_count: 2 })).toBe(2);
  });
  it('suffix beats entity count', () => {
    expect(characterImageCount('character:a-imgs:1', { image_count: 2 })).toBe(1);
  });
});

describe('combinedRefBudget', () => {
  const refsMode = omniModes.modes[2];

  it('sums images + character counts and stays within 7', () => {
    const budget = combinedRefBudget({ image_slugs: ['@a', '@b', '@c'] }, ['character:x-imgs:2', 'character:y-imgs:2'], refsMode);
    expect(budget.used).toBe(7);
    expect(budget.max).toBe(7);
    expect(budget.blocking).toBe(false);
    expect(budget.meter).toBe('refs · 7/7');
  });

  it('blocks at 8/7', () => {
    const budget = combinedRefBudget({ image_slugs: ['@a', '@b', '@c', '@d'] }, ['character:x-imgs:2', 'character:y-imgs:2'], refsMode);
    expect(budget.used).toBe(8);
    expect(budget.blocking).toBe(true);
    expect(budget.message).toContain('budget exceeded');
  });

  it('tightens the cap to 5 in edit mode', () => {
    const editMode = omniModes.modes[3];
    const budget = combinedRefBudget({ image_slugs: ['@a', '@b', '@c'] }, [], editMode);
    expect(budget.max).toBe(5);
    expect(budget.meter).toBe('edit · 3/5');
  });

  it('counts suffix-less characters as one image each', () => {
    const budget = combinedRefBudget({ image_slugs: ['@a', '@b'] }, ['character:a', 'character:b'], refsMode);
    expect(budget.used).toBe(4);
  });
});

describe('deriveStripSlots', () => {
  it('unions all mode asset slots for a moded model', () => {
    const option = { modes: omniModes, schema: { properties: {} } } as Pick<ModelOption, 'modes' | 'schema'>;
    const slots = deriveStripSlots(option);
    const params = slots.map((s) => s.param);
    expect(params).toEqual(expect.arrayContaining(['first_frame_slug', 'image_slugs', 'character_refs', 'video_slug']));
    // deduped: image_slugs appears in two modes but once
    expect(slots.filter((s) => s.param === 'image_slugs')).toHaveLength(1);
  });

  it('lists schema asset fields for a flat model', () => {
    const option = {
      modes: null,
      schema: { type: 'object' as const, properties: { first_frame_slug: { type: 'string' as const }, last_frame_slug: { type: 'string' as const }, prompt: { type: 'string' as const } } },
    } as Pick<ModelOption, 'modes' | 'schema'>;
    const slots = deriveStripSlots(option);
    expect(slots.map((s) => s.param)).toEqual(['first_frame_slug', 'last_frame_slug']);
  });
});

describe('routeDrop', () => {
  const slots = deriveStripSlots({ modes: omniModes, schema: { properties: {} } } as Pick<ModelOption, 'modes' | 'schema'>);

  it('routes a video drop to the video slot (set)', () => {
    expect(routeDrop('video', slots)).toEqual({ param: 'video_slug', action: 'set' });
  });

  it('routes an image drop to image_slugs (append)', () => {
    expect(routeDrop('image', slots)).toEqual({ param: 'image_slugs', action: 'append' });
  });
});

describe('appendImageSlug', () => {
  it('appends deduped', () => {
    expect(appendImageSlug({ image_slugs: ['@a'] }, 'b')).toEqual(['@a', '@b']);
    expect(appendImageSlug({ image_slugs: ['@a'] }, '@a')).toEqual(['@a']);
  });
});

describe('toggleFirstFramePin', () => {
  it('pins an image out of image_slugs', () => {
    const result = toggleFirstFramePin({ image_slugs: ['@a', '@b'] }, '@a');
    expect(result.first_frame_slug).toBe('@a');
    expect(result.image_slugs).toEqual(['@b']);
  });

  it('pinning another swaps the previous back into image_slugs', () => {
    const result = toggleFirstFramePin({ first_frame_slug: '@a', image_slugs: ['@b'] }, '@b');
    expect(result.first_frame_slug).toBe('@b');
    expect(result.image_slugs).toEqual(['@a']);
  });

  it('unpins back into image_slugs', () => {
    const result = toggleFirstFramePin({ first_frame_slug: '@a', image_slugs: [] }, '@a');
    expect(result.first_frame_slug).toBe('');
    expect(result.image_slugs).toEqual(['@a']);
  });
});
