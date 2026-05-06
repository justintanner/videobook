import type { AssetType, ClipState, MediaItem } from './types';
import { cardTone } from '@/theme/domains';

export type CardTone =
  | 'ready'
  | 'error'
  | 'final'
  | 'uploading'
  | 'generating'
  | 'generating-image'
  | 'downloading'
  | 'rendering'
  | 'transcribing'
  | 'loading'
  | 'deleting'
  | 'video'
  | 'image'
  | 'character'
  | 'audio'
  | 'script'
  | 'plan';

export interface CardVisualState {
  tone: CardTone;
  status: ClipState;
  color: string;
  rgb: string;
  border: string;
  glow: string;
  soft: string;
  faint: string;
  dot: string | null;
  stateClass: string | null;
  cursorClass: string;
  isReady: boolean;
  isError: boolean;
  isFinal: boolean;
  isGold: boolean;
  isActive: boolean;
  isDeleting: boolean;
}

const PROCESSING_DOT = 'bg-primary animate-pulse';
const GENERATING_DOT = 'bg-green-500 animate-pulse';
const IMAGE_GENERATING_DOT = 'bg-blue-500 animate-pulse';

export const READY_RAW = 'var(--color-primary)';
export const FINAL_RAW = '#fbbf24';
export const ERROR_RAW = '#ef4444';
export const DELETING_RAW = 'rgba(239, 68, 68, 0.4)';

const TONE_STYLES: Record<CardTone, {
  color: string;
  rgb: string;
  border: string;
  glow: string;
  soft: string;
  faint: string;
  dot: string | null;
}> = {
  ready: {
    color: READY_RAW,
    rgb: '0, 255, 255',
    border: 'rgba(0, 255, 255, 0.35)',
    glow: 'rgba(0, 255, 255, 0.35)',
    soft: 'rgba(0, 255, 255, 0.14)',
    faint: 'rgba(0, 255, 255, 0.06)',
    dot: null,
  },
  error: {
    color: ERROR_RAW,
    rgb: '239, 68, 68',
    border: 'rgba(239, 68, 68, 0.65)',
    glow: 'rgba(239, 68, 68, 0.45)',
    soft: 'rgba(239, 68, 68, 0.18)',
    faint: 'rgba(239, 68, 68, 0.08)',
    dot: 'bg-red-500',
  },
  // Final-state asset cards keep slightly stronger border/glow than the
  // generic cardTone factory, since the gold treatment is the most visually
  // significant in the app.
  final: {
    ...cardTone('final'),
    border: 'rgba(251, 191, 36, 0.55)',
    glow: 'rgba(251, 191, 36, 0.45)',
    soft: 'rgba(251, 191, 36, 0.16)',
    faint: 'rgba(251, 191, 36, 0.08)',
  },
  uploading: {
    color: READY_RAW,
    rgb: '0, 255, 255',
    border: 'rgba(0, 255, 255, 0.45)',
    glow: 'rgba(0, 255, 255, 0.45)',
    soft: 'rgba(0, 255, 255, 0.16)',
    faint: 'rgba(0, 255, 255, 0.06)',
    dot: PROCESSING_DOT,
  },
  generating: {
    color: '#22c55e',
    rgb: '34, 197, 94',
    border: 'rgba(34, 197, 94, 0.5)',
    glow: 'rgba(34, 197, 94, 0.45)',
    soft: 'rgba(34, 197, 94, 0.16)',
    faint: 'rgba(34, 197, 94, 0.07)',
    dot: GENERATING_DOT,
  },
  'generating-image': {
    color: '#3b82f6',
    rgb: '59, 130, 246',
    border: 'rgba(59, 130, 246, 0.55)',
    glow: 'rgba(59, 130, 246, 0.45)',
    soft: 'rgba(59, 130, 246, 0.17)',
    faint: 'rgba(59, 130, 246, 0.07)',
    dot: IMAGE_GENERATING_DOT,
  },
  downloading: {
    color: '#22c55e',
    rgb: '34, 197, 94',
    border: 'rgba(34, 197, 94, 0.5)',
    glow: 'rgba(34, 197, 94, 0.45)',
    soft: 'rgba(34, 197, 94, 0.16)',
    faint: 'rgba(34, 197, 94, 0.07)',
    dot: GENERATING_DOT,
  },
  rendering: {
    color: READY_RAW,
    rgb: '0, 255, 255',
    border: 'rgba(0, 255, 255, 0.45)',
    glow: 'rgba(0, 255, 255, 0.45)',
    soft: 'rgba(0, 255, 255, 0.16)',
    faint: 'rgba(0, 255, 255, 0.07)',
    dot: PROCESSING_DOT,
  },
  transcribing: {
    color: READY_RAW,
    rgb: '0, 255, 255',
    border: 'rgba(0, 255, 255, 0.45)',
    glow: 'rgba(0, 255, 255, 0.45)',
    soft: 'rgba(0, 255, 255, 0.16)',
    faint: 'rgba(0, 255, 255, 0.07)',
    dot: PROCESSING_DOT,
  },
  loading: {
    color: '#88d4ff',
    rgb: '136, 212, 255',
    border: 'rgba(136, 212, 255, 0.45)',
    glow: 'rgba(136, 212, 255, 0.45)',
    soft: 'rgba(136, 212, 255, 0.16)',
    faint: 'rgba(136, 212, 255, 0.07)',
    dot: PROCESSING_DOT,
  },
  deleting: {
    color: ERROR_RAW,
    rgb: '239, 68, 68',
    border: DELETING_RAW,
    glow: 'rgba(239, 68, 68, 0.35)',
    soft: 'rgba(239, 68, 68, 0.14)',
    faint: 'rgba(239, 68, 68, 0.06)',
    dot: null,
  },
  video: cardTone('video'),
  image: cardTone('image'),
  // Character is a sub-domain of image (an image asset used as a reference).
  character: cardTone('image'),
  // Audio is a sub-domain of video (timeline audio lanes live with video).
  audio: cardTone('video'),
  // Script is a sub-domain of plan (text version of a plan).
  script: cardTone('plan'),
  plan: cardTone('plan'),
};

const TYPE_TO_TONE: Record<AssetType, CardTone> = {
  video: 'video',
  image: 'image',
  character: 'character',
  audio: 'audio',
  script: 'script',
  plan: 'plan',
  final: 'final',
};

const PIPELINE_STATES = new Set<ClipState>([
  'processing',
  'analyzing',
  'trimming',
  'cropping',
  'splicing',
  'reversing',
  'changing-speed',
  'replacing-audio',
  'isolating',
]);

export function isPipelineState(status: ClipState): boolean {
  return PIPELINE_STATES.has(status);
}

function toneForStatus(status: ClipState, item: Pick<MediaItem, 'type'>): CardTone {
  if (status === 'error') return 'error';
  if (status === 'deleting') return 'deleting';
  if (item.type === 'final' && (status === 'ready' || isRenderingState(status))) return 'final';
  if (isRenderingState(status)) return 'rendering';
  if (status === 'uploading') return 'uploading';
  if (status === 'downloading') return 'downloading';
  if (status === 'transcribing') return 'transcribing';
  if (status === 'loading') return 'loading';
  if (status === 'generating' || isPipelineState(status)) {
    return item.type === 'image' || item.type === 'character' ? 'generating-image' : 'generating';
  }
  return TYPE_TO_TONE[item.type] ?? 'ready';
}

function stateClassForTone(tone: CardTone): string | null {
  switch (tone) {
    case 'uploading':
      return 'clip-state-uploading';
    case 'generating':
      return 'clip-state-generating';
    case 'generating-image':
      return 'clip-state-generating-image';
    case 'downloading':
      return 'clip-state-downloading';
    case 'rendering':
      return 'clip-state-rendering';
    case 'transcribing':
      return 'clip-state-transcribing';
    case 'loading':
      return 'clip-state-loading';
    case 'deleting':
      return 'clip-state-deleting';
    case 'final':
      return 'clip-state-final';
    case 'ready':
    case 'video':
    case 'image':
    case 'character':
    case 'audio':
    case 'script':
    case 'plan':
      return 'clip-state-ready';
    case 'error':
      return null;
  }
}

function cursorClassForTone(tone: CardTone): string {
  if (tone === 'deleting') return 'pointer-events-none cursor-default';
  if (tone === 'uploading' || tone === 'generating' || tone === 'generating-image' || tone === 'downloading' || tone === 'rendering' || tone === 'loading') {
    return 'cursor-wait';
  }
  return 'cursor-pointer';
}

const IDLE_TONES = new Set<CardTone>(['ready', 'video', 'image', 'character', 'audio', 'script', 'plan']);

// Tones whose animation should run in the asset type's color rather than a
// fixed state color. Keeps the animation/timing but tints it per asset type.
const TYPED_STATE_TONES = new Set<CardTone>([
  'uploading',
  'generating',
  'generating-image',
  'downloading',
  'rendering',
  'transcribing',
  'loading',
]);

export function getCardVisualState(item: MediaItem): CardVisualState {
  const status = item.status ?? 'ready';
  const tone = toneForStatus(status, item);
  const baseStyle = TONE_STYLES[tone];
  const typeStyle = TYPED_STATE_TONES.has(tone)
    ? TONE_STYLES[TYPE_TO_TONE[item.type] ?? 'ready']
    : null;
  const style = typeStyle
    ? {
        ...baseStyle,
        color: typeStyle.color,
        rgb: typeStyle.rgb,
        border: typeStyle.border,
        glow: typeStyle.glow,
        soft: typeStyle.soft,
        faint: typeStyle.faint,
      }
    : baseStyle;
  const isGold = tone === 'final' || tone === 'plan';
  const isActive = !IDLE_TONES.has(tone) && tone !== 'final' && tone !== 'error';

  return {
    tone,
    status,
    ...style,
    stateClass: stateClassForTone(tone),
    cursorClass: cursorClassForTone(tone),
    isReady: status === 'ready',
    isError: tone === 'error',
    isFinal: item.type === 'final',
    isGold,
    isActive,
    isDeleting: tone === 'deleting',
  };
}

export function colorWithAlpha(visual: Pick<CardVisualState, 'rgb'>, alpha: number): string {
  return `rgba(${visual.rgb}, ${alpha})`;
}

export function isRenderingState(status: string): boolean {
  return status === 'rendering' ||
    status === 'rendering-landscape' ||
    status === 'rendering-portrait' ||
    status === 'render-queued' ||
    status === 'render-queued-landscape' ||
    status === 'render-queued-portrait' ||
    status === 'rendering-square' ||
    status === 'render-queued-square';
}
