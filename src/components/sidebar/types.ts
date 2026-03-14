export type AssetType = 'video' | 'image' | 'script' | 'audio' | 'plan' | 'final';

export type ClipState =
  | 'uploading'
  | 'loading'
  | 'generating'
  | 'rendering'
  | 'rendering-landscape'
  | 'rendering-portrait'
  | 'render-queued'
  | 'render-queued-landscape'
  | 'render-queued-portrait'
  | 'rendering-square'
  | 'render-queued-square'
  | 'downloading'
  | 'transcribing'
  | 'untranscribed'
  | 'corrupt'
  | 'error'
  | 'ready'
  | 'approved';

export interface MediaItem {
  id: string;
  type: AssetType;
  slug: string;
  title: string;
  status?: ClipState;
  filePath: string;
  durationSeconds?: number | null;
  width?: number | null;
  height?: number | null;
  origin?: string | null;
  thumbnailSrc?: string | null;
  prompt?: string | null;
}
