import type { OverlayProps } from './types';
import { ClockOverlay } from './ClockOverlay';

function renderLabel(status: string | undefined): string {
  if (status?.startsWith('render-queued')) return 'QUEUED';
  return 'RENDERING';
}

export function ElfBuildingOverlay({ item }: OverlayProps) {
  return <ClockOverlay item={item} label={renderLabel(item.status)} />;
}
