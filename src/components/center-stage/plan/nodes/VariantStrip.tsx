// Filmstrip of per-model swap variants for a frame (scene.swap.image{N}_variants).
// Each thumbnail promotes that variant into the slot on click (the legacy
// "select" path → replace_plan_scene_frame_swap). The currently-selected variant
// is ringed.
import { Loader2, AlertTriangle } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import { SHORT_LABEL_BY_MODEL, parseVariantKey } from '../charSwapModel';

export const VARIANT_STRIP_H = 50;

function variantLabel(key: string): string {
  const parsed = parseVariantKey(key);
  if (!parsed) return key;
  const short = SHORT_LABEL_BY_MODEL[parsed.model];
  return parsed.provider === 'fal' ? `${short}·f` : short;
}

export function VariantStrip({
  variants,
  selectedAssetId,
  mediaItems,
  onPick,
}: {
  variants: Record<string, string> | undefined;
  selectedAssetId: string | null | undefined;
  mediaItems: MediaItem[];
  onPick: (assetId: string) => void;
}) {
  const entries = variants ? Object.entries(variants) : [];
  if (entries.length === 0) return null;
  return (
    <div className="nodrag flex gap-1 mt-1.5 overflow-x-auto scrollbar-hide" style={{ height: VARIANT_STRIP_H }}>
      {entries.map(([key, assetId]) => {
        const item = mediaItems.find((m) => m.id === assetId);
        const ready = item?.status === 'ready';
        const errored = item?.status === 'error';
        const thumb = ready ? (item?.thumbnailSrc ?? item?.filePath ?? null) : null;
        const selected = assetId === selectedAssetId;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onPick(assetId)}
            title={`${variantLabel(key)} — click to use`}
            className={cn(
              'relative shrink-0 w-10 h-10 rounded overflow-hidden border transition-colors',
              selected ? 'border-emerald-400 ring-1 ring-emerald-400/50' : 'border-zinc-700 hover:border-zinc-500',
            )}
          >
            {thumb ? (
              <img src={thumb} alt={variantLabel(key)} className="w-full h-full object-cover" />
            ) : (
              <div className="w-full h-full flex items-center justify-center bg-black/60">
                {errored ? (
                  <AlertTriangle className="w-3 h-3 text-rose-400/70" />
                ) : (
                  <Loader2 className="w-3 h-3 animate-spin text-emerald-300/60" />
                )}
              </div>
            )}
            <span className="absolute bottom-0 inset-x-0 text-[7px] font-mono text-center bg-black/75 text-emerald-200/90 leading-tight">
              {variantLabel(key)}
            </span>
          </button>
        );
      })}
    </div>
  );
}
