import type { ClipState } from './types';

export interface StateAccent {
  /** Tailwind class for the SidebarMicroThumb status dot, including animation
   *  modifier. `null` means no dot is rendered for this state. */
  dot: string | null;
  /** Resolved color for the CardShell SVG corner stroke and other inline-style
   *  consumers. Hex / rgba / CSS var. `null` means use the default ready color
   *  (`READY_RAW`). The original `getCornerStrokeColor` mapped only six states
   *  to a translucent rgba and let everything else fall through to
   *  `var(--color-primary)` — preserve that. */
  cornerRaw: string | null;
}

const PROCESSING_DOT = 'bg-primary animate-pulse';
const GENERATING_DOT = 'bg-green-500 animate-pulse';

export const READY_RAW = 'var(--color-primary)';
export const FINAL_RAW = '#fbbf24';
export const ERROR_RAW = '#ef4444';
export const DELETING_RAW = 'rgba(239, 68, 68, 0.4)';
export const GENERATING_IMAGE_RAW = 'rgba(59, 130, 246, 0.7)';

/** SlugBadge inline-border colors. Three discrete states (error / gold / cyan)
 *  with their own opacities, distinct from the card corner stroke. */
export const SLUG_BADGE_BORDER = {
  error: 'rgba(239, 68, 68, 0.7)',
  gold: 'rgba(251, 191, 36, 0.5)',
  cyan: 'rgba(0, 255, 255, 0.2)',
} as const;

export const STATE_ACCENTS: Record<ClipState, StateAccent> = {
  uploading:                  { dot: PROCESSING_DOT, cornerRaw: 'rgba(0, 255, 255, 0.7)' },
  loading:                    { dot: PROCESSING_DOT, cornerRaw: 'rgba(0, 255, 255, 0.5)' },
  generating:                 { dot: GENERATING_DOT, cornerRaw: 'rgba(34, 197, 94, 0.7)' },
  processing:                 { dot: null,           cornerRaw: null },
  analyzing:                  { dot: null,           cornerRaw: null },
  trimming:                   { dot: null,           cornerRaw: null },
  splicing:                   { dot: null,           cornerRaw: null },
  reversing:                  { dot: null,           cornerRaw: null },
  'changing-speed':           { dot: null,           cornerRaw: null },
  'replacing-audio':          { dot: null,           cornerRaw: null },
  isolating:                  { dot: null,           cornerRaw: null },
  rendering:                  { dot: PROCESSING_DOT, cornerRaw: 'rgba(0, 255, 255, 0.7)' },
  'rendering-landscape':      { dot: PROCESSING_DOT, cornerRaw: null },
  'rendering-portrait':       { dot: PROCESSING_DOT, cornerRaw: null },
  'rendering-square':         { dot: PROCESSING_DOT, cornerRaw: null },
  'render-queued':            { dot: PROCESSING_DOT, cornerRaw: null },
  'render-queued-landscape':  { dot: PROCESSING_DOT, cornerRaw: null },
  'render-queued-portrait':   { dot: PROCESSING_DOT, cornerRaw: null },
  'render-queued-square':     { dot: PROCESSING_DOT, cornerRaw: null },
  downloading:                { dot: GENERATING_DOT, cornerRaw: 'rgba(34, 197, 94, 0.7)' },
  transcribing:               { dot: PROCESSING_DOT, cornerRaw: 'rgba(0, 255, 255, 0.7)' },
  deleting:                   { dot: null,           cornerRaw: DELETING_RAW },
  error:                      { dot: 'bg-red-500',   cornerRaw: ERROR_RAW },
  ready:                      { dot: null,           cornerRaw: null },
};

export interface AccentSelector {
  status: ClipState | undefined;
  isFinal: boolean;
  isError: boolean;
  isReady: boolean;
  itemType?: string;
}

/** Mirrors the original `getCornerStrokeColor` decision tree exactly so the
 *  card-shell SVG corner keeps its prior color for every input combination. */
export function cornerStrokeColor({ status, isFinal, isError, isReady, itemType }: AccentSelector): string {
  if (isError) return ERROR_RAW;
  if (status === 'deleting') return DELETING_RAW;
  if (isFinal && (isReady || isRenderingState(status ?? ''))) return FINAL_RAW;
  if (isReady) return READY_RAW;
  if (status === 'generating' && itemType === 'image') return GENERATING_IMAGE_RAW;
  const accent = status ? STATE_ACCENTS[status] : undefined;
  return accent?.cornerRaw ?? READY_RAW;
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
