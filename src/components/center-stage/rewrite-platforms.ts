import type { RewritePlatform } from '@/hooks/useRewriteScript';

export const PLATFORM_OPTIONS: Array<{ value: RewritePlatform | ''; label: string }> = [
  { value: '', label: 'None' },
  { value: 'ig', label: 'Instagram' },
  { value: 'tiktok', label: 'TikTok' },
  { value: 'youtube', label: 'YouTube' },
];
