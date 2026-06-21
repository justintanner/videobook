import { Monitor, Smartphone, Square } from 'lucide-react';
import type { MediaItem } from '@/components/sidebar/types';

// ── Types ──

export type ViewerSize = 'landscape' | 'portrait' | 'square' | 'original';
export type BackTab = 'settings' | 'files' | 'history';
export type ManifestFile = { name: string; size_bytes: number; extension: string | null };

// ── Constants ──

export const RENDERING_STATUSES = new Set<string>([
  'rendering', 'rendering-landscape', 'rendering-portrait', 'rendering-square',
  'render-queued', 'render-queued-landscape', 'render-queued-portrait', 'render-queued-square',
]);

/** True when the status represents a render in flight (queued or running). */
export function isRenderingStatus(status: string | undefined): boolean {
  return !!status && RENDERING_STATUSES.has(status);
}

/** True when an in-flight render targets `orient` (the unscoped `rendering` /
 *  `render-queued` statuses match any orientation). */
export function renderingTargetsOrientation(status: string | undefined, orient: ViewerSize): boolean {
  if (!isRenderingStatus(status)) return false;
  if (status === 'rendering' || status === 'render-queued') return true;
  return status!.endsWith(`-${orient}`);
}

const BINARY_EXTENSIONS = new Set(['mp4', 'mp3', 'wav', 'jpg', 'jpeg', 'png', 'gif', 'webp', 'webm', 'mov', 'flac', 'aac', 'ogg']);
const IMAGE_EXTENSIONS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp']);

// ── Utilities ──

export function isBinaryFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return BINARY_EXTENSIONS.has(ext);
}

export function isImageFile(name: string): boolean {
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** On-screen graphics (OSG) and watermarks bake into the rendered orientations
 *  only — never into the raw `original.mp4` source — so their controls are gated
 *  off while viewing `original`. */
export function supportsOnScreenGraphics(size: ViewerSize): boolean {
  return size !== 'original';
}

export function ratioLabel(size: ViewerSize, item?: MediaItem): string {
  switch (size) {
    case 'original':
      return item?.width && item?.height ? `/original ${item.width}x${item.height}` : '/original';
    case 'landscape':
      return '/landscape 1920x1080';
    case 'portrait':
      return '/portrait 1080x1920';
    case 'square':
      return '/square 1080x1080';
  }
}

export const ratioIcons: Record<ViewerSize, typeof Monitor> = {
  original: Monitor,
  landscape: Monitor,
  portrait: Smartphone,
  square: Square,
};
