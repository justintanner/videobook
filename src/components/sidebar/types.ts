export type AssetType = 'video' | 'image' | 'script' | 'audio' | 'plan' | 'final' | 'character';

export type PendingState = 'queued' | 'processing' | 'success' | 'fail' | 'expired';

export type ClipState =
  | 'uploading'
  | 'loading'
  | 'generating'
  | 'processing'
  | 'analyzing'
  | 'trimming'
  | 'splicing'
  | 'reversing'
  | 'changing-speed'
  | 'replacing-audio'
  | 'isolating'
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
  | 'deleting'
  | 'ready';

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
  renders?: string[];
  duration?: number | null;
  waveform?: number[] | null;
  frameDirs?: Record<string, string[]>;
  pendingState?: PendingState;
  pendingProgress?: number;
  pendingTaskType?: string;
  createdAt?: string;
  failedAt?: string;
  failedMessage?: string;
  failedTaskType?: string;
}
