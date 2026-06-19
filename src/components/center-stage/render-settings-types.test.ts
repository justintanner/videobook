import { describe, it, expect } from 'vitest';
import { storedToRenderSettings } from './render-settings-types';

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
