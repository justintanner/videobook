import type { OverlayProps } from './types';
import { ClockOverlay } from './ClockOverlay';

export function UploadingOverlay({ item }: OverlayProps) {
  return <ClockOverlay item={item} />;
}
