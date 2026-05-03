import type { OverlayProps } from './types';
import { ClockOverlay } from './ClockOverlay';

export function RenderingOverlay({ item }: OverlayProps) {
  return <ClockOverlay item={item} />;
}
