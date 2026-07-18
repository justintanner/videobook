import { describe, it, expect } from 'vitest';
import { getDefaultRenderSettings, storedToRenderSettings } from './render-settings-types';

describe('render setting defaults', () => {
  it.each(['portrait', 'landscape'])('starts %s clips with clean audio and subtitles off', (orientation) => {
    const result = getDefaultRenderSettings(orientation);

    expect(result.subtitlesEnabled).toBe(false);
    expect(result.audioVolume).toBe(100);
    expect(result.audioFadeIn).toBe(0);
    expect(result.audioFadeOut).toBe(0);
  });

  it('uses the same defaults for missing stored fields while preserving overrides', () => {
    const defaults = storedToRenderSettings({});
    const overridden = storedToRenderSettings({
      subtitlesEnabled: true,
      audioVolume: 65,
      audioFadeIn: 250,
      audioFadeOut: 300,
    });

    expect(defaults.subtitlesEnabled).toBe(false);
    expect(defaults.audioVolume).toBe(100);
    expect(defaults.audioFadeIn).toBe(0);
    expect(defaults.audioFadeOut).toBe(0);
    expect(overridden.subtitlesEnabled).toBe(true);
    expect(overridden.audioVolume).toBe(65);
    expect(overridden.audioFadeIn).toBe(250);
    expect(overridden.audioFadeOut).toBe(300);
  });
});

describe('storedToRenderSettings OSG resolution', () => {
  it('resolves osgAssetSrc from the asset id via the injected resolver', () => {
    const resolve = (id: string) => (id === 'img-logo' ? '/assets/img-logo/original.png' : null);
    const result = storedToRenderSettings({ osgAssetId: 'img-logo' }, resolve);
    expect(result.osgAssetId).toBe('img-logo');
    expect(result.osgAssetSrc).toBe('/assets/img-logo/original.png');
  });

  it('derives the asset id from a legacy osgImagePath and resolves its src', () => {
    const resolve = (id: string) => (id === 'img-logo' ? '/assets/img-logo/original.png' : null);
    const result = storedToRenderSettings({ osgImagePath: '/var/projects/p/assets/img-logo/original.png' }, resolve);
    expect(result.osgAssetId).toBe('img-logo');
    expect(result.osgAssetSrc).toBe('/assets/img-logo/original.png');
  });

  it('leaves osgAssetSrc null when the resolver cannot find the asset', () => {
    const result = storedToRenderSettings({ osgAssetId: 'img-missing' }, () => null);
    expect(result.osgAssetId).toBe('img-missing');
    expect(result.osgAssetSrc).toBeNull();
  });

  it('keeps both osg fields null when no OSG asset is stored', () => {
    const result = storedToRenderSettings({}, () => '/should/not/be/used.png');
    expect(result.osgAssetId).toBeNull();
    expect(result.osgAssetSrc).toBeNull();
  });

  it('does not call the resolver when there is no OSG asset', () => {
    const result = storedToRenderSettings({});
    expect(result.osgAssetSrc).toBeNull();
  });
});
