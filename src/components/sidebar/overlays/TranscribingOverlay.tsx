import type { OverlayProps } from './types';
import { ClockOverlay } from './ClockOverlay';

export function TranscribingOverlay({ item }: OverlayProps) {
  return <ClockOverlay item={item} />;
}
