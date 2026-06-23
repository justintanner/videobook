// Layout helpers for flow-canvas nodes (kept out of the component file so
// react-refresh stays happy).
import type { SourceAspect } from '@/lib/plan-aspect';

// Per-node image height derived from the source aspect ratio (width/height),
// clamped so portrait sources don't make nodes absurdly tall. Used to size the
// flip container so the GUI↔JSON faces share a stable height.
export function nodeImageHeight(width: number, aspect: SourceAspect, maxH = 220): number {
  const h = Math.round(width / (aspect.ratio || 16 / 9));
  return Math.max(110, Math.min(maxH, h));
}
