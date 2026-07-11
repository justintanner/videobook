import { describe, expect, it } from 'vitest';
import type { ModelOption, ModelModes } from '@/components/gen/types';
import {
  appendImageSlug,
  appendSlug,
  characterImageCount,
  combinedRefBudget,
  deriveStripSlots,
  imageRefMax,
  paramForAssetSlug,
  routeDrop,
  toggleFirstFramePin,
  type StripSlot,
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

describe('imageRefMax', () => {
  const option = (overrides: Partial<Pick<ModelOption, 'modes' | 'validation'>> = {}): Pick<ModelOption, 'modes' | 'validation'> => ({
    modes: null,
    validation: { valid: true, missing_required: [], warnings: [] },
    ...overrides,
  });

  it('uses the active mode image_slugs slot max when present', () => {
    const r2v = omniModes.modes[2];
    expect(imageRefMax(option({ modes: omniModes }), r2v)).toBe(7);
    const edit = omniModes.modes[3];
    expect(imageRefMax(option({ modes: omniModes }), edit)).toBe(5);
  });

  it('falls back to validation.image_slots.max when the mode has no image_slugs slot', () => {
    const t2v = omniModes.modes[0];
    expect(imageRefMax(option({ modes: omniModes, validation: { valid: true, missing_required: [], warnings: [], image_slots: { min: 0, max: 7 } } }), t2v)).toBe(7);
  });

  it('uses validation.image_slots.max for a flat (non-moded) model', () => {
    expect(imageRefMax(option({ validation: { valid: true, missing_required: [], warnings: [], image_slots: { min: 0, max: 10 } } }), null)).toBe(10);
  });

  it('returns null when no cap is available', () => {
    expect(imageRefMax(option(), null)).toBeNull();
    const t2v = omniModes.modes[0];
    expect(imageRefMax(option({ modes: omniModes }), t2v)).toBeNull();
  });
});

describe('combinedRefBudget', () => {
  const refsMode = omniModes.modes[2];

  it('sums images + character counts and stays within 7', () => {
    const budget = combinedRefBudget({ image_slugs: ['@a', '@b', '@c'] }, ['character:x-imgs:2', 'character:y-imgs:2'], refsMode, 7);
    expect(budget.used).toBe(7);
    expect(budget.max).toBe(7);
    expect(budget.blocking).toBe(false);
    expect(budget.meter).toBe('refs · 7/7');
  });

  it('blocks at 8/7', () => {
    const budget = combinedRefBudget({ image_slugs: ['@a', '@b', '@c', '@d'] }, ['character:x-imgs:2', 'character:y-imgs:2'], refsMode, 7);
    expect(budget.used).toBe(8);
    expect(budget.blocking).toBe(true);
    expect(budget.message).toContain('budget exceeded');
  });

  it('tightens the cap to 5 in edit mode', () => {
    const editMode = omniModes.modes[3];
    const budget = combinedRefBudget({ image_slugs: ['@a', '@b', '@c'] }, [], editMode, 5);
    expect(budget.max).toBe(5);
    expect(budget.meter).toBe('edit · 3/5');
  });

  it('counts suffix-less characters as one image each', () => {
    const budget = combinedRefBudget({ image_slugs: ['@a', '@b'] }, ['character:a', 'character:b'], refsMode, 7);
    expect(budget.used).toBe(4);
  });

  it('renders a count-only meter and never blocks when max is null', () => {
    const budget = combinedRefBudget({ image_slugs: ['@a', '@b', '@c', '@d'] }, ['character:x-imgs:2', 'character:y-imgs:2'], refsMode, null);
    expect(budget.max).toBeNull();
    expect(budget.blocking).toBe(false);
    expect(budget.message).toBeUndefined();
    expect(budget.meter).toBe('refs · 8');
  });
});

describe('deriveStripSlots', () => {
  it('unions all mode asset slots for a moded model when no active mode', () => {
    const option = { modes: omniModes, schema: { properties: {} } } as Pick<ModelOption, 'modes' | 'schema'>;
    const slots = deriveStripSlots(option);
    const params = slots.map((s) => s.param);
    expect(params).toEqual(expect.arrayContaining(['first_frame_slug', 'image_slugs', 'character_refs', 'video_slug']));
    // deduped: image_slugs appears in two modes but once
    expect(slots.filter((s) => s.param === 'image_slugs')).toHaveLength(1);
  });

  it('scopes slots to the active mode only', () => {
    const option = { modes: omniModes, schema: { properties: {} } } as Pick<ModelOption, 'modes' | 'schema'>;
    const t2v = deriveStripSlots(option, omniModes.modes[0]);
    expect(t2v).toEqual([]);
    const i2v = deriveStripSlots(option, omniModes.modes[1]);
    expect(i2v.map((s) => s.param)).toEqual(['first_frame_slug']);
    const edit = deriveStripSlots(option, omniModes.modes[3]);
    expect(edit.map((s) => s.param)).toEqual(['video_slug', 'image_slugs']);
    expect(edit.find((s) => s.param === 'image_slugs')?.max).toBe(5);
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

  it('returns empty param when no matching slot (text mode)', () => {
    expect(routeDrop('video', [])).toEqual({ param: '', action: 'set' });
    expect(routeDrop('audio', [])).toEqual({ param: '', action: 'set' });
    expect(routeDrop('image', [])).toEqual({ param: '', action: 'set' });
  });

  it('appends to video_slugs / audio_slugs array params', () => {
    const seedanceSlots: StripSlot[] = [
      { param: 'image_slugs', kind: 'image', label: 'Images', max: null },
      { param: 'video_slugs', kind: 'video', label: 'Videos', max: 3 },
      { param: 'audio_slugs', kind: 'audio', label: 'Audio', max: 3 },
    ];
    expect(routeDrop('video', seedanceSlots)).toEqual({ param: 'video_slugs', action: 'append' });
    expect(routeDrop('audio', seedanceSlots)).toEqual({ param: 'audio_slugs', action: 'append' });
    expect(routeDrop('image', seedanceSlots)).toEqual({ param: 'image_slugs', action: 'append' });
  });
});

describe('appendImageSlug / appendSlug', () => {
  it('appends deduped', () => {
    expect(appendImageSlug({ image_slugs: ['@a'] }, 'b')).toEqual(['@a', '@b']);
    expect(appendImageSlug({ image_slugs: ['@a'] }, '@a')).toEqual(['@a']);
  });

  it('appendSlug respects max and works for video_slugs', () => {
    expect(appendSlug({ video_slugs: ['@vid-a'] }, 'video_slugs', '@vid-b', 3)).toEqual(['@vid-a', '@vid-b']);
    expect(appendSlug({ video_slugs: ['@a', '@b', '@c'] }, 'video_slugs', '@d', 3)).toEqual(['@a', '@b', '@c']);
  });
});

describe('paramForAssetSlug', () => {
  const seedanceSlots: StripSlot[] = [
    { param: 'image_slugs', kind: 'image', label: 'Images', max: null },
    { param: 'video_slugs', kind: 'video', label: 'Videos', max: 3 },
    { param: 'audio_slugs', kind: 'audio', label: 'Audio', max: 3 },
  ];

  it('maps img-/vid-/aud- prefixes to the right array slot', () => {
    expect(paramForAssetSlug('@img-style', seedanceSlots)).toEqual({ param: 'image_slugs', action: 'append' });
    expect(paramForAssetSlug('vid-clip', seedanceSlots)).toEqual({ param: 'video_slugs', action: 'append' });
    expect(paramForAssetSlug('@aud-music', seedanceSlots)).toEqual({ param: 'audio_slugs', action: 'append' });
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
