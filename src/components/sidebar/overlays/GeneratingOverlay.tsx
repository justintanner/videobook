import type { OverlayProps } from './types';
import { ClockOverlay } from './ClockOverlay';

interface GeneratingOverlayProps extends OverlayProps {
  /** Reserved for callers that previously customized the overlay label
   *  (e.g. "PROCESSING", "ANALYZING"). The clock no longer renders text,
   *  so this value is currently unused but kept to avoid touching call sites. */
  label?: string;
}

export function GeneratingOverlay({ item }: GeneratingOverlayProps) {
  return <ClockOverlay item={item} startedAt={item.pendingStartedAt ?? null} />;
}
