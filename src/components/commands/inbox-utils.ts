type Orientation = 'portrait' | 'square' | 'landscape';

export function getCardOrientation(width: number | null | undefined, height: number | null | undefined): Orientation {
  const w = width ?? 1920;
  const h = height ?? 1080;
  if (h > w) return 'portrait';
  if (w === h) return 'square';
  return 'landscape';
}

export function getCardWidthClass(orientation: Orientation): string {
  if (orientation === 'portrait') return 'min-w-[220px] w-[220px]';
  if (orientation === 'square') return 'w-[220px]';
  return 'w-[300px]';
}

export function getRatioLabel(orientation: Orientation): string {
  if (orientation === 'portrait') return '9:16';
  if (orientation === 'square') return '1:1';
  return '16:9';
}

export function getRatioBadgeClasses(orientation: Orientation): string {
  if (orientation === 'portrait') return 'bg-violet-500/15 text-violet-400/80';
  if (orientation === 'square') return 'bg-amber-500/15 text-amber-400/80';
  return 'bg-primary/10 text-primary/60';
}

export function getStatusTag(status: string | undefined): string {
  if (status === 'generating') return 'GEN';
  if (status === 'downloading') return 'DL';
  if (status === 'loading') return 'LOAD';
  if (status === 'transcribing') return 'TRANS';
  return status?.toUpperCase() ?? '...';
}
