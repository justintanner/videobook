import type { OverlayProps } from './types';
import { ClockOverlay } from './ClockOverlay';

export function ElfBuildingOverlay({ item }: OverlayProps) {
  return <ClockOverlay item={item} />;
}
