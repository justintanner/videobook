import type { OverlayProps } from './types';
import { ClockOverlay } from './ClockOverlay';

interface GeneratingOverlayProps extends OverlayProps {
  /** Label override for pipeline states (PROCESSING, ANALYZING, TRIMMING, …).
   *  Defaults to "GENERATING". */
  label?: string;
}

export function GeneratingOverlay({ item, label }: GeneratingOverlayProps) {
  return <ClockOverlay item={item} label={label ?? 'GENERATING'} startedAt={item.pendingStartedAt ?? null} />;
}
