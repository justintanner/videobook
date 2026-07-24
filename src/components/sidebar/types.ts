import type { OsgPosition } from '@/components/center-stage/render-settings-types';

export type ArtifactKind = 'video' | 'image' | 'script' | 'audio' | 'notebook' | 'final' | 'character';

/** Resolved on-screen graphic overlay summary for a video/final asset. `src` is
 *  the overlay image's displayable URL, resolved client-side from `assetId`. */
export interface OsgInfo {
  assetId: string;
  src: string | null;
  position: OsgPosition;
  size: 'small' | 'medium' | 'large';
  scale: number;
  startSeconds?: number | null;
  endSeconds?: number | null;
}

export type PendingState = 'queued' | 'processing' | 'success' | 'fail' | 'expired';

export type ClipState =
  | 'uploading'
  | 'loading'
  | 'generating'
  | 'processing'
  | 'analyzing'
  | 'trimming'
  | 'cropping'
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
  | 'archiving'
  | 'transcribing'
  | 'error'
  | 'deleting'
  | 'ready';

// Compile-time guard that this client mirror stays in sync with the engine's
// `ArtifactStatus` union. The fs package is server-only at runtime (pulls
// better-sqlite3), but `import type` is erased by the bundler so the client
// build is unaffected. If a status is added on either side without the other,
// one of these assignments fails to compile.
import type { ArtifactStatus as EngineAssetStatus } from 'videobook-engine';
const _clientToEngine: EngineAssetStatus = '' as ClipState;
const _engineToClient: ClipState = '' as EngineAssetStatus;
void _clientToEngine;
void _engineToClient;

export interface MediaItem {
  id: string;
  type: ArtifactKind;
  slug: string;
  title: string;
  status?: ClipState;
  filePath: string;
  width?: number | null;
  height?: number | null;
  origin?: string | null;
  thumbnailSrc?: string | null;
  prompt?: string | null;
  renders?: string[];
  duration?: number | null;
  waveform?: number[] | null;
  frameDirs?: Record<string, string[]>;
  archiveId?: string | null;
  archivedAt?: string | null;
  pendingState?: PendingState;
  pendingProgress?: number;
  pendingTaskType?: string;
  /** Unix ms when the underlying generation job started, sourced from the
   *  pending task's `createdAt`. Undefined when the asset isn't generating
   *  or no pending entry exists yet. Drives the GeneratingOverlay clock. */
  pendingStartedAt?: number | null;
  createdAt?: string;
  failedAt?: string;
  failedMessage?: string;
  failedTaskType?: string;
  /** Unix seconds when user first viewed this asset, or null if still unseen.
   *  Drives the NEW badge in the sidebar. */
  seenAt?: number | null;
  /** Character assets only: whether an ElevenLabs voice is assigned. Null/undefined
   *  for non-character assets or when unknown. Lets template auto-pick prefer a
   *  voiced host for Clip Show. */
  hasVoice?: boolean | null;
  /** Video/final assets only: configured OSG overlay (resolved src), or null. */
  osg?: OsgInfo | null;
}
