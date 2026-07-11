import { describe, it, expect } from 'vitest';
import type { ModelModes } from './types';
import {
  isEmptyModeValue,
  getMode,
  visibleParams,
  inferModeKey,
  filterValuesForMode,
  modeRequiredMissing,
  modeAssetParams,
  modeBudgetWarnings,
  effectiveToolName,
} from './modes';

// Mirror of the server VIDEO_TOOL_MODES entry for generate_google_omni_video.
const OMNI: ModelModes = {
  shared_params: ['prompt', 'aspect_ratio', 'seed', 'voice_refs', 'duration'],
  default_mode: 't2v',
  modes: [
    { key: 't2v', label: 'text', params: [] },
    {
      key: 'i2v', label: 'first-frame', params: ['first_frame_slug'], required: ['first_frame_slug'],
      asset_slots: [{ param: 'first_frame_slug', kind: 'image', label: 'First Frame' }],
    },
    {
      key: 'r2v', label: 'refs', params: ['image_slugs', 'character_refs'],
      asset_slots: [{ param: 'image_slugs', kind: 'image', label: 'References', min: 0, max: 7 }],
    },
    {
      key: 'edit', label: 'video-edit',
      params: ['video_slug', 'video_clip_start', 'video_clip_ends', 'image_slugs', 'character_refs'],
      hidden_shared_params: ['duration'],
      required: ['video_slug'],
      asset_slots: [
        { param: 'video_slug', kind: 'video', label: 'Source Clip' },
        { param: 'image_slugs', kind: 'image', label: 'References', min: 0, max: 5 },
      ],
      param_overrides: { voice_refs: { maxItems: 3 } },
    },
  ],
};

describe('isEmptyModeValue', () => {
  it('treats undefined, null, blank strings and empty arrays as empty', () => {
    expect(isEmptyModeValue(undefined)).toBe(true);
    expect(isEmptyModeValue(null)).toBe(true);
    expect(isEmptyModeValue('')).toBe(true);
    expect(isEmptyModeValue('   ')).toBe(true);
    expect(isEmptyModeValue([])).toBe(true);
  });
  it('treats 0, false and non-empty values as non-empty', () => {
    expect(isEmptyModeValue(0)).toBe(false);
    expect(isEmptyModeValue(false)).toBe(false);
    expect(isEmptyModeValue('x')).toBe(false);
    expect(isEmptyModeValue(['a'])).toBe(false);
  });
});

describe('getMode', () => {
  it('resolves by key and falls back to default for null/unknown', () => {
    expect(getMode(OMNI, 'edit').key).toBe('edit');
    expect(getMode(OMNI, null).key).toBe('t2v');
    expect(getMode(OMNI, 'nope').key).toBe('t2v');
  });
});

describe('visibleParams', () => {
  it('t2v shows shared params incl. duration', () => {
    const v = visibleParams(OMNI, 't2v');
    expect(v.has('prompt')).toBe(true);
    expect(v.has('duration')).toBe(true);
    expect(v.has('voice_refs')).toBe(true);
    expect(v.has('video_slug')).toBe(false);
    expect(v.has('first_frame_slug')).toBe(false);
  });
  it('edit hides duration and adds clip params', () => {
    const v = visibleParams(OMNI, 'edit');
    expect(v.has('duration')).toBe(false);
    expect(v.has('video_slug')).toBe(true);
    expect(v.has('video_clip_start')).toBe(true);
    expect(v.has('image_slugs')).toBe(true);
    expect(v.has('voice_refs')).toBe(true);
  });
});

describe('inferModeKey', () => {
  it('empty values → default (t2v), even with a default duration', () => {
    expect(inferModeKey(OMNI, {})).toBe('t2v');
    expect(inferModeKey(OMNI, { duration: '8', image_slugs: [] })).toBe('t2v');
  });
  it('a filled video_slug → edit (even alongside image_slugs)', () => {
    expect(inferModeKey(OMNI, { video_slug: '@vid-a' })).toBe('edit');
    expect(inferModeKey(OMNI, { video_slug: '@vid-a', image_slugs: ['@img-1'] })).toBe('edit');
  });
  it('image_slugs or character_refs with no clip → refs', () => {
    expect(inferModeKey(OMNI, { image_slugs: ['@img-1'] })).toBe('r2v');
    expect(inferModeKey(OMNI, { character_refs: ['character:x'] })).toBe('r2v');
  });
  it('a first frame with nothing else → i2v', () => {
    expect(inferModeKey(OMNI, { first_frame_slug: '@img-start' })).toBe('i2v');
  });
  it('conflicting first_frame + video → edit (most specific wins)', () => {
    expect(inferModeKey(OMNI, { first_frame_slug: '@img-a', video_slug: '@vid-b' })).toBe('edit');
  });
});

describe('filterValuesForMode', () => {
  const full = {
    prompt: 'hi', aspect_ratio: '16:9', seed: 0, voice_refs: ['v:1'], duration: '8',
    first_frame_slug: '@img-a', image_slugs: ['@img-1'], video_slug: '@vid-b',
    video_clip_start: 2, video_clip_ends: 4, extra_unknown: 'keep-me?',
  };
  it('t2v keeps shared (incl. duration), drops all mode-specific slugs', () => {
    const out = filterValuesForMode(OMNI, 't2v', full);
    expect(out).toEqual({ prompt: 'hi', aspect_ratio: '16:9', seed: 0, voice_refs: ['v:1'], duration: '8' });
    expect(out).not.toHaveProperty('image_slugs');
    expect(out).not.toHaveProperty('video_slug');
    expect(out).not.toHaveProperty('first_frame_slug');
    expect(out).not.toHaveProperty('extra_unknown');
  });
  it('edit drops duration and first_frame, keeps window + refs', () => {
    const out = filterValuesForMode(OMNI, 'edit', full);
    expect(out).not.toHaveProperty('duration');
    expect(out).not.toHaveProperty('first_frame_slug');
    expect(out.video_slug).toBe('@vid-b');
    expect(out.video_clip_start).toBe(2);
    expect(out.image_slugs).toEqual(['@img-1']);
    expect(out.voice_refs).toEqual(['v:1']);
  });
});

describe('modeRequiredMissing', () => {
  it('flags an empty required slug and clears once filled', () => {
    const edit = getMode(OMNI, 'edit');
    expect(modeRequiredMissing(edit, {})).toEqual(['video_slug']);
    expect(modeRequiredMissing(edit, { video_slug: '@vid-a' })).toEqual([]);
  });
});

describe('modeAssetParams', () => {
  it('unions all slot params across modes', () => {
    expect(modeAssetParams(OMNI)).toEqual(new Set(['first_frame_slug', 'image_slugs', 'video_slug']));
  });
});

describe('modeBudgetWarnings', () => {
  it('warns when a slot max is exceeded', () => {
    const edit = getMode(OMNI, 'edit');
    const warns = modeBudgetWarnings(edit, { image_slugs: ['a', 'b', 'c', 'd', 'e', 'f'] });
    expect(warns.some((w) => w.includes('References') && w.includes('5'))).toBe(true);
  });
  it('warns when a param_overrides maxItems is exceeded (voices in edit)', () => {
    const edit = getMode(OMNI, 'edit');
    const warns = modeBudgetWarnings(edit, { voice_refs: ['a', 'b', 'c', 'd'] });
    expect(warns.some((w) => w.includes('voice refs') && w.includes('3'))).toBe(true);
  });
  it('no warnings within budget', () => {
    const edit = getMode(OMNI, 'edit');
    expect(modeBudgetWarnings(edit, { image_slugs: ['a'], voice_refs: ['a'] })).toEqual([]);
  });
});

describe('effectiveToolName', () => {
  it('falls back to the option tool name when the mode has none', () => {
    expect(effectiveToolName({ tool_name: 'generate_google_omni_video', modes: OMNI }, 'edit'))
      .toBe('generate_google_omni_video');
  });
  it('uses a per-mode tool_name when present', () => {
    const modes: ModelModes = {
      shared_params: ['prompt'], default_mode: 'a',
      modes: [
        { key: 'a', label: 'A', params: [] },
        { key: 'b', label: 'B', params: [], tool_name: 'extend_thing_video' },
      ],
    };
    expect(effectiveToolName({ tool_name: 'base_video', modes }, 'b')).toBe('extend_thing_video');
    expect(effectiveToolName({ tool_name: 'base_video', modes }, 'a')).toBe('base_video');
  });
  it('returns the option tool name when there are no modes', () => {
    expect(effectiveToolName({ tool_name: 'generate_kling30_video', modes: null }, null))
      .toBe('generate_kling30_video');
  });
});

const SEEDANCE_MINI: ModelModes = {
  shared_params: [
    'prompt', 'aspect_ratio', 'resolution', 'duration',
    'generate_audio', 'web_search', 'nsfw_checker',
  ],
  default_mode: 'text',
  modes: [
    { key: 'text', label: 'text', params: [] },
    {
      key: 'refs',
      label: 'refs',
      params: ['image_slugs', 'video_slugs', 'audio_slugs'],
      asset_slots: [
        { param: 'image_slugs', kind: 'image', label: 'Images', min: 0, max: null },
        { param: 'video_slugs', kind: 'video', label: 'Videos', min: 0, max: 3 },
        { param: 'audio_slugs', kind: 'audio', label: 'Audio', min: 0, max: 3 },
      ],
    },
  ],
};

describe('seedance mini modes', () => {
  it('infers refs when any of image/video/audio is filled', () => {
    expect(inferModeKey(SEEDANCE_MINI, { image_slugs: ['@img-a'] })).toBe('refs');
    expect(inferModeKey(SEEDANCE_MINI, { video_slugs: ['@vid-a'] })).toBe('refs');
    expect(inferModeKey(SEEDANCE_MINI, { audio_slugs: ['@aud-a'] })).toBe('refs');
  });

  it('defaults to text when no assets filled', () => {
    expect(inferModeKey(SEEDANCE_MINI, { prompt: 'hello' })).toBe('text');
  });

  it('filterValuesForMode drops asset keys in text mode', () => {
    const out = filterValuesForMode(SEEDANCE_MINI, 'text', {
      prompt: 'x',
      duration: '8',
      image_slugs: ['@img-a'],
      video_slugs: ['@vid-a'],
      audio_slugs: ['@aud-a'],
    });
    expect(out.prompt).toBe('x');
    expect(out.duration).toBe('8');
    expect(out.image_slugs).toBeUndefined();
    expect(out.video_slugs).toBeUndefined();
    expect(out.audio_slugs).toBeUndefined();
  });

  it('modeBudgetWarnings flags video_slugs over max', () => {
    const refs = SEEDANCE_MINI.modes.find((m) => m.key === 'refs')!;
    const warns = modeBudgetWarnings(refs, {
      video_slugs: ['@a', '@b', '@c', '@d'],
    });
    expect(warns.some((w) => w.includes('Videos'))).toBe(true);
  });
});
