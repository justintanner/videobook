import type { MediaItem } from '@/components/sidebar/types';

export function isFailedPending(item: MediaItem): boolean {
  if (item.status === 'error') return true;
  const ps = item.pendingState;
  return ps === 'fail' || ps === 'expired';
}
