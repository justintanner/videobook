// One inline micro-thumb that replaces an asset token ("[Image N]" / "@slug")
// inside the rich-prompt overlay. CRITICAL: the chip is sized to exactly the
// token's character width (`${widthCh}ch`). Because every prompt field is
// monospace, `Nch` is the precise advance width of the N underlying characters,
// so the chip occupies the same horizontal space as the transparent token text
// beneath it — the textarea caret and the overlay stay aligned with no
// contentEditable. Height is capped under the line box so it never grows a line.
import { cn } from '@/lib/utils';

export interface ChipThumb {
  thumbnailSrc: string | null;
  type?: 'image' | 'video' | 'character' | 'audio';
  label: string; // tooltip / alt
  badge?: string; // e.g. "1" for [Image 1]
}

export function AssetThumbChip({
  widthCh,
  thumb,
  rawText,
}: {
  widthCh: number;
  thumb: ChipThumb | null;
  rawText: string;
}) {
  const resolved = thumb?.thumbnailSrc ?? null;
  return (
    <span
      className={cn(
        'relative inline-flex shrink-0 items-center justify-center overflow-hidden rounded-[3px] border align-middle',
        resolved ? 'border-emerald-400/50' : 'border-emerald-400/25 bg-emerald-500/10',
      )}
      style={{ width: `${widthCh}ch`, height: '1.15em' }}
      title={thumb?.label ?? rawText}
      aria-hidden="true"
    >
      {resolved ? (
        <img src={resolved} alt={thumb?.label ?? rawText} className="h-full w-full object-cover" />
      ) : (
        <span className="truncate px-px text-[0.82em] font-mono leading-none text-emerald-200/70">
          {rawText}
        </span>
      )}
      {thumb?.badge && (
        <span className="absolute left-0 top-0 rounded-br-[3px] bg-emerald-500/90 px-[1px] text-[0.62em] font-mono font-bold leading-none text-black">
          {thumb.badge}
        </span>
      )}
      {thumb?.type === 'video' && resolved && (
        <span className="absolute bottom-0 right-0 rounded-tl-[3px] bg-black/70 px-[1px] text-[0.62em] leading-none text-white">
          ▶
        </span>
      )}
    </span>
  );
}
