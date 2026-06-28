import { describe, expect, it } from 'vitest';
import type { SourceAspect } from '@/lib/plan-aspect';
import { nodeImageHeight } from './nodeLayout';

function aspect(ratio: number): SourceAspect {
  return { width: null, height: null, ratio, css: `${ratio}`, hasMetadata: false };
}

describe('nodeImageHeight', () => {
  it('clamps a portrait (9:16) source so the node is not towering', () => {
    // 240 / 0.5625 = 427 → clamped to the default cap.
    expect(nodeImageHeight(240, aspect(9 / 16))).toBe(220);
  });

  it('leaves a landscape (16:9) source at its natural height', () => {
    // 240 / 1.778 ≈ 135, within [110, 220].
    expect(nodeImageHeight(240, aspect(16 / 9))).toBe(135);
  });

  it('honours a higher cap for the wider swap/video nodes', () => {
    // 520 / 0.5625 = 924 → clamped to the explicit 300 cap.
    expect(nodeImageHeight(520, aspect(9 / 16), 300)).toBe(300);
  });

  it('enforces a floor so near-panoramic sources stay tappable', () => {
    expect(nodeImageHeight(240, aspect(21 / 9))).toBe(110);
  });

  it('falls back to 16:9 when the ratio is zero', () => {
    expect(nodeImageHeight(240, aspect(0))).toBe(135);
  });
});
