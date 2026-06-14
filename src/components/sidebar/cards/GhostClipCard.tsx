import { useMemo } from 'react';
import { CardShell } from './CardShell';
import type { MediaItem } from '../types';

interface GhostClipCardProps {
  /** Asset id returned by the enqueue tool — used to reconcile against the real
   *  card once sync surfaces it. */
  id: string;
  type: 'video' | 'image';
  prompt: string;
  /** Unix ms when the user submitted, seeds the GENERATING clock. */
  startedAt: number;
}

/**
 * Optimistic placeholder shown in the clips bar the instant a generation is
 * submitted, covering the gap until the next `sync` poll surfaces the real
 * asset. Renders the exact generating look (CardShell → GeneratingOverlay clock)
 * by handing CardShell a synthetic, in-`generating` MediaItem, so the swap to
 * the real card is seamless.
 */
export function GhostClipCard({ id, type, prompt, startedAt }: GhostClipCardProps) {
  const item = useMemo<MediaItem>(() => ({
    id,
    type,
    slug: id,
    title: prompt || 'Generating…',
    status: 'generating',
    filePath: '',
    prompt,
    pendingState: 'processing',
    pendingStartedAt: startedAt,
  }), [id, type, prompt, startedAt]);

  // CardShell's StateOverlay (status='generating') fills the tile; the children
  // are just the empty backdrop the overlay sits on.
  return (
    <CardShell item={item}>
      <div className="absolute inset-0" />
    </CardShell>
  );
}
