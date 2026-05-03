// Mirrors server/src/tools/generate-wan27-videoedit-video.ts:102-106.
// Source videos longer than (MAX + TOLERANCE) are rejected by Wan 2.7 Video Edit.
export const VIDEO_EDIT_MAX_SEC = 10.0;
export const VIDEO_EDIT_TOLERANCE_SEC = 0.05;

export function isOverEditCap(durationSec: number): boolean {
  return durationSec > VIDEO_EDIT_MAX_SEC + VIDEO_EDIT_TOLERANCE_SEC;
}

// Mirrors formatDuration in src/components/sidebar/cards/badges.tsx:30-43.
export function formatSecondsBadge(sec: number): string {
  if (sec >= 60) {
    const total = Math.round(sec);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  if (Number.isInteger(sec)) return `${sec}s`;
  return `${sec.toFixed(2).replace(/\.?0+$/, '')}s`;
}
