import type { MediaItem } from '../types';
import { CardShell } from './CardShell';
import { SlugBadge } from './badges';

interface ScriptCardProps {
  item: MediaItem;
}

export function ScriptCard({ item }: ScriptCardProps) {
  const status = item.status ?? 'ready';
  const isError = status === 'error';
  const isCorrupt = status === 'corrupt';
  const scriptText = item.prompt;

  return (
    <CardShell item={item}>
      {/* CONTENT - Script */}
      <div className="w-full h-full relative overflow-hidden">
        {/* Dark gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/70 to-black/40" />
        {/* Scanlines overlay */}
        <div className="absolute inset-0 scanlines pointer-events-none" />
        {/* Vignette effect */}
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_at_center,transparent_40%,rgba(0,0,0,0.6)_100%)]" />
        <div className="absolute inset-0 p-2 overflow-hidden">
          <p className="text-[10px] leading-tight text-primary/40 line-clamp-[8] whitespace-pre-wrap">{scriptText}</p>
        </div>
      </div>

      {/* Slug badge */}
      {!isCorrupt && <SlugBadge slug={item.slug} colorScheme="cyan" isError={isError} />}
    </CardShell>
  );
}
