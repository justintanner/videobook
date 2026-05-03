import type { OverlayProps } from './types';
import { ClockOverlay } from './ClockOverlay';

export function DownloadingOverlay({ item }: OverlayProps) {
  return <ClockOverlay item={item} />;
}
