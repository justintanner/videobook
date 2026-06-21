import { describe, it, expect } from 'vitest';
import { isRenderingStatus, renderingTargetsOrientation, RENDERING_STATUSES } from './viewer-types';

describe('isRenderingStatus', () => {
  it('is true for every status in RENDERING_STATUSES', () => {
    for (const status of RENDERING_STATUSES) {
      expect(isRenderingStatus(status)).toBe(true);
    }
  });

  it('is false for ready / undefined / unrelated statuses', () => {
    expect(isRenderingStatus(undefined)).toBe(false);
    expect(isRenderingStatus('ready')).toBe(false);
    expect(isRenderingStatus('error')).toBe(false);
    expect(isRenderingStatus('transcribing')).toBe(false);
  });
});

describe('renderingTargetsOrientation', () => {
  it('matches the orientation named in the status', () => {
    expect(renderingTargetsOrientation('rendering-portrait', 'portrait')).toBe(true);
    expect(renderingTargetsOrientation('render-queued-portrait', 'portrait')).toBe(true);
    expect(renderingTargetsOrientation('rendering-landscape', 'square')).toBe(false);
    expect(renderingTargetsOrientation('render-queued-square', 'portrait')).toBe(false);
  });

  it('treats unscoped rendering statuses as matching any orientation', () => {
    expect(renderingTargetsOrientation('rendering', 'portrait')).toBe(true);
    expect(renderingTargetsOrientation('rendering', 'landscape')).toBe(true);
    expect(renderingTargetsOrientation('render-queued', 'square')).toBe(true);
  });

  it('is false for non-rendering statuses', () => {
    expect(renderingTargetsOrientation('ready', 'portrait')).toBe(false);
    expect(renderingTargetsOrientation(undefined, 'portrait')).toBe(false);
  });
});
