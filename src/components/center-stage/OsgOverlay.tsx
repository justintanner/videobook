import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, X, Trash2, ImageIcon, RefreshCw } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { MediaItem } from '@/components/sidebar/types';
import {
  OSG_POSITIONS,
  type OsgPosition,
} from './render-settings-types';

export type OsgSize = 'small' | 'medium' | 'large';

export interface OsgApplyValue {
  osgAssetId: string;
  position: OsgPosition;
  size: OsgSize;
  scale: number;
}

interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface OsgOverlayProps {
  videoRef: React.RefObject<HTMLVideoElement | null>;
  imageAssets: MediaItem[];
  /** Currently selected overlay image asset id (preselected on open), or null. */
  initialOsgAssetId: string | null;
  initialPosition: OsgPosition;
  initialSize: OsgSize;
  initialScale: number;
  onApply: (value: OsgApplyValue) => void;
  onRemove: () => void;
  onCancel: () => void;
}

// Mirror the server's OsgOverlay sizing (server/src/remotion/OsgOverlay.tsx):
// base width as a fraction of the video width, multiplied by osgScale. We snap a
// freely-drawn box to the nearest preset and store the residual as scale.
const SIZE_FACTOR: Record<OsgSize, number> = {
  small: 0.07,
  medium: 0.14,
  large: 0.21,
};
const EDGE_PADDING = 0.02; // 2% of width, matching the server placement.
const MIN_BOX_FRACTION = 0.02;

type DragMode =
  | { kind: 'move'; startPx: RectPx; startPointer: { x: number; y: number } }
  | { kind: 'resize'; corner: 'nw' | 'ne' | 'sw' | 'se'; anchor: { x: number; y: number } };

function computeContentRect(videoEl: HTMLVideoElement | null): RectPx | null {
  if (!videoEl) return null;
  const rect = videoEl.getBoundingClientRect();
  const containerW = rect.width;
  const containerH = rect.height;
  if (containerW <= 0 || containerH <= 0) return null;

  const vidW = videoEl.videoWidth;
  const vidH = videoEl.videoHeight;
  if (!vidW || !vidH) return { x: 0, y: 0, w: containerW, h: containerH };

  const containerAspect = containerW / containerH;
  const videoAspect = vidW / vidH;
  if (videoAspect > containerAspect) {
    const renderedH = containerW / videoAspect;
    return { x: 0, y: (containerH - renderedH) / 2, w: containerW, h: renderedH };
  }
  const renderedW = containerH * videoAspect;
  return { x: (containerW - renderedW) / 2, y: 0, w: renderedW, h: containerH };
}

/** Build the initial box from a stored anchor position + size + scale, mirroring
 *  the server's edge-padding placement so the box round-trips to the same anchor. */
function rectFromAnchor(
  content: RectPx,
  position: OsgPosition,
  size: OsgSize,
  scale: number,
  imageAspect: number,
): RectPx {
  const padding = EDGE_PADDING * content.w;
  const w = SIZE_FACTOR[size] * Math.min(2, Math.max(0.1, scale)) * content.w;
  const h = w / imageAspect;
  const [vertical, horizontal] = position.split('-');
  const x = horizontal === 'left' ? content.x + padding
    : horizontal === 'right' ? content.x + content.w - w - padding
    : content.x + (content.w - w) / 2;
  const y = vertical === 'top' ? content.y + padding
    : vertical === 'bottom' ? content.y + content.h - h - padding
    : content.y + (content.h - h) / 2;
  return { x, y, w, h };
}

function clampRect(rect: RectPx, content: RectPx): RectPx {
  let { x, y, w, h } = rect;
  if (w > content.w) w = content.w;
  if (h > content.h) h = content.h;
  if (x < content.x) x = content.x;
  if (y < content.y) y = content.y;
  if (x + w > content.x + content.w) x = content.x + content.w - w;
  if (y + h > content.y + content.h) y = content.y + content.h - h;
  return { x, y, w, h };
}

function resizeFromAnchor(
  anchor: { x: number; y: number },
  pointer: { x: number; y: number },
  imageAspect: number,
  content: RectPx,
): RectPx {
  const minSize = Math.max(16, MIN_BOX_FRACTION * content.w);
  const dx = pointer.x - anchor.x;
  const dy = pointer.y - anchor.y;
  const signX = dx >= 0 ? 1 : -1;
  const signY = dy >= 0 ? 1 : -1;
  let aw = Math.max(Math.abs(dx), minSize);
  let ah = Math.max(Math.abs(dy), minSize);
  if (aw / ah > imageAspect) aw = ah * imageAspect;
  else ah = aw / imageAspect;

  const maxW = signX > 0 ? content.x + content.w - anchor.x : anchor.x - content.x;
  const maxH = signY > 0 ? content.y + content.h - anchor.y : anchor.y - content.y;
  if (aw > maxW) { aw = Math.max(minSize, maxW); ah = aw / imageAspect; }
  if (ah > maxH) { ah = Math.max(minSize, maxH); aw = ah * imageAspect; }

  const x = signX > 0 ? anchor.x : anchor.x - aw;
  const y = signY > 0 ? anchor.y : anchor.y - ah;
  return { x, y, w: aw, h: ah };
}

/** Bucket the box centre into one of the 9 anchors by thirds of the content rect. */
function snapPosition(box: RectPx, content: RectPx): OsgPosition {
  const cx = (box.x + box.w / 2 - content.x) / content.w;
  const cy = (box.y + box.h / 2 - content.y) / content.h;
  const horizontal = cx < 1 / 3 ? 'left' : cx < 2 / 3 ? 'center' : 'right';
  const vertical = cy < 1 / 3 ? 'top' : cy < 2 / 3 ? 'middle' : 'bottom';
  return `${vertical}-${horizontal}` as OsgPosition;
}

/** Map the box width fraction to the nearest preset + a residual scale multiplier. */
function snapSize(box: RectPx, content: RectPx): { size: OsgSize; scale: number } {
  const f = box.w / content.w;
  let best: OsgSize = 'medium';
  let bestDist = Infinity;
  (Object.keys(SIZE_FACTOR) as OsgSize[]).forEach((s) => {
    const d = Math.abs(f - SIZE_FACTOR[s]);
    if (d < bestDist) { bestDist = d; best = s; }
  });
  const scale = Math.min(2, Math.max(0.1, f / SIZE_FACTOR[best]));
  return { size: best, scale };
}

const ANCHOR_LABEL: Record<OsgPosition, string> = {
  'top-left': 'TL', 'top-center': 'TC', 'top-right': 'TR',
  'middle-left': 'ML', 'middle-center': 'MC', 'middle-right': 'MR',
  'bottom-left': 'BL', 'bottom-center': 'BC', 'bottom-right': 'BR',
};

const HANDLE_BASE = 'absolute w-3 h-3 bg-emerald-300 border border-zinc-900 shadow-md';

export function OsgOverlay({
  videoRef, imageAssets, initialOsgAssetId, initialPosition, initialSize, initialScale,
  onApply, onRemove, onCancel,
}: OsgOverlayProps) {
  const [osgAssetId, setOsgAssetId] = useState<string | null>(initialOsgAssetId);
  const [content, setContent] = useState<RectPx | null>(null);
  const [rectPx, setRectPx] = useState<RectPx | null>(null);
  // null until the overlay image's intrinsic aspect ratio is known; placing the
  // box before then would size it to a wrong (square) aspect.
  const [imageAspect, setImageAspect] = useState<number | null>(null);
  const dragRef = useRef<DragMode | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const placedRef = useRef(false);

  const selectedImage = useMemo(
    () => imageAssets.find((a) => a.id === osgAssetId) ?? null,
    [imageAssets, osgAssetId],
  );
  const imageSrc = selectedImage?.thumbnailSrc || selectedImage?.filePath || null;

  // Recompute the content rect on mount, on metadata load, and on resize.
  useEffect(() => {
    const videoEl = videoRef.current;
    if (!videoEl) return;
    const recompute = () => setContent(computeContentRect(videoEl));
    recompute();
    videoEl.addEventListener('loadedmetadata', recompute);
    window.addEventListener('resize', recompute);
    const ro = new ResizeObserver(recompute);
    ro.observe(videoEl);
    return () => {
      videoEl.removeEventListener('loadedmetadata', recompute);
      window.removeEventListener('resize', recompute);
      ro.disconnect();
    };
  }, [videoRef]);

  // Place the initial box once we have both a content rect and the image aspect.
  useEffect(() => {
    if (!content || !imageSrc || imageAspect == null || placedRef.current) return;
    placedRef.current = true;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRectPx(rectFromAnchor(content, initialPosition, initialSize, initialScale, imageAspect));
  }, [content, imageSrc, imageAspect, initialPosition, initialSize, initialScale]);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      setImageAspect(img.naturalWidth / img.naturalHeight);
    }
  }, []);

  const selectImage = useCallback((id: string) => {
    setOsgAssetId(id);
    placedRef.current = false;
    setImageAspect(null);
  }, []);

  const pointerToOverlay = useCallback((e: React.PointerEvent | PointerEvent) => {
    const overlay = overlayRef.current;
    if (!overlay) return { x: 0, y: 0 };
    const r = overlay.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }, []);

  const handleMoveStart = (e: React.PointerEvent) => {
    if (!rectPx) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    dragRef.current = { kind: 'move', startPx: rectPx, startPointer: pointerToOverlay(e) };
  };

  const handleResizeStart = (corner: 'nw' | 'ne' | 'sw' | 'se') => (e: React.PointerEvent) => {
    if (!rectPx) return;
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const anchor =
      corner === 'nw' ? { x: rectPx.x + rectPx.w, y: rectPx.y + rectPx.h }
      : corner === 'ne' ? { x: rectPx.x, y: rectPx.y + rectPx.h }
      : corner === 'sw' ? { x: rectPx.x + rectPx.w, y: rectPx.y }
      : { x: rectPx.x, y: rectPx.y };
    dragRef.current = { kind: 'resize', corner, anchor };
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !content) return;
    const pointer = pointerToOverlay(e);
    if (drag.kind === 'move') {
      const dx = pointer.x - drag.startPointer.x;
      const dy = pointer.y - drag.startPointer.y;
      setRectPx(clampRect({ ...drag.startPx, x: drag.startPx.x + dx, y: drag.startPx.y + dy }, content));
    } else {
      setRectPx(resizeFromAnchor(drag.anchor, pointer, imageAspect ?? 1, content));
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) {
      try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      dragRef.current = null;
    }
  };

  const snapped = useMemo(() => {
    if (!rectPx || !content) return null;
    return { position: snapPosition(rectPx, content), ...snapSize(rectPx, content) };
  }, [rectPx, content]);

  const handleApply = () => {
    if (!osgAssetId || !snapped) return;
    onApply({ osgAssetId, position: snapped.position, size: snapped.size, scale: snapped.scale });
  };

  // ── Image picker (shown until an overlay image is chosen) ──
  const renderPicker = () => (
    <div className="absolute inset-0 z-30 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="max-w-[min(90%,520px)] max-h-[80%] overflow-auto rounded-lg border border-emerald-500/40 bg-zinc-950/95 p-4">
        <div className="mb-3 flex items-center gap-2 text-emerald-300">
          <ImageIcon className="w-4 h-4" />
          <span className="text-xs font-mono font-bold tracking-widest">CHOOSE OSG IMAGE</span>
        </div>
        {imageAssets.length === 0 ? (
          <div className="px-4 py-8 text-center text-xs font-mono text-muted-foreground">
            No image assets in this project yet.
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-2">
            {imageAssets.map((img) => (
              <button
                key={img.id}
                tabIndex={-1}
                onClick={() => selectImage(img.id)}
                title={img.slug}
                className="group relative aspect-square overflow-hidden rounded border border-zinc-700 hover:border-emerald-400 transition-colors"
              >
                {(img.thumbnailSrc || img.filePath) ? (
                  <img src={img.thumbnailSrc || img.filePath} alt={img.title} draggable={false} className="w-full h-full object-cover" />
                ) : (
                  <div className="flex h-full w-full items-center justify-center"><ImageIcon className="w-4 h-4 text-zinc-600" /></div>
                )}
              </button>
            ))}
          </div>
        )}
        <div className="mt-3 flex justify-end">
          <button
            tabIndex={-1}
            onClick={onCancel}
            className="px-2 py-0.5 text-xs flex items-center gap-1 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded transition-colors"
          >
            <X className="w-3 h-3" /> Cancel
          </button>
        </div>
      </div>
    </div>
  );

  if (!osgAssetId || !imageSrc) {
    return (
      <div ref={overlayRef} className="absolute inset-0 z-30 select-none">
        {renderPicker()}
      </div>
    );
  }

  if (!content || !rectPx) {
    return (
      <div ref={overlayRef} className="absolute inset-0 z-30 pointer-events-none">
        {imageSrc && <img src={imageSrc} alt="" onLoad={handleImageLoad} className="hidden" />}
      </div>
    );
  }

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-30 select-none"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Anchor guide dots — highlight the snapped one */}
      {OSG_POSITIONS.map((pos) => {
        const [v, h] = pos.split('-');
        const left = h === 'left' ? '8%' : h === 'right' ? '92%' : '50%';
        const top = v === 'top' ? '8%' : v === 'bottom' ? '92%' : '50%';
        const active = snapped?.position === pos;
        return (
          <div
            key={pos}
            className={cn(
              'absolute rounded-full pointer-events-none transition-all',
              active ? 'w-2.5 h-2.5 bg-emerald-300 shadow-[0_0_10px_rgba(110,231,183,0.9)]' : 'w-1.5 h-1.5 bg-white/30',
            )}
            style={{
              left: content.x + (parseFloat(left) / 100) * content.w,
              top: content.y + (parseFloat(top) / 100) * content.h,
              transform: 'translate(-50%, -50%)',
            }}
          />
        );
      })}

      {/* OSG box */}
      <div
        className="absolute border border-emerald-300/90 cursor-move shadow-[0_0_0_1px_rgba(0,0,0,0.4)]"
        style={{ left: rectPx.x, top: rectPx.y, width: rectPx.w, height: rectPx.h }}
        onPointerDown={handleMoveStart}
      >
        <img src={imageSrc} alt="" draggable={false} onLoad={handleImageLoad} className="w-full h-full object-contain pointer-events-none" />
        <div className={cn(HANDLE_BASE, 'cursor-nwse-resize')} style={{ left: -6, top: -6 }} onPointerDown={handleResizeStart('nw')} />
        <div className={cn(HANDLE_BASE, 'cursor-nesw-resize')} style={{ right: -6, top: -6 }} onPointerDown={handleResizeStart('ne')} />
        <div className={cn(HANDLE_BASE, 'cursor-nesw-resize')} style={{ left: -6, bottom: -6 }} onPointerDown={handleResizeStart('sw')} />
        <div className={cn(HANDLE_BASE, 'cursor-nwse-resize')} style={{ right: -6, bottom: -6 }} onPointerDown={handleResizeStart('se')} />
      </div>

      {/* Readout (top) */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-2 bg-zinc-950/80 border border-emerald-700/50 rounded px-2 py-1">
        <span className="text-xs font-mono text-emerald-300">/osg</span>
        {snapped && (
          <span className="text-xs font-mono text-muted-foreground">
            {ANCHOR_LABEL[snapped.position]} · {snapped.size[0].toUpperCase()}
          </span>
        )}
        <button
          tabIndex={-1}
          onClick={() => { setOsgAssetId(null); placedRef.current = false; }}
          title="Change image"
          className="ml-1 text-muted-foreground hover:text-emerald-300 transition-colors"
        >
          <RefreshCw className="w-3 h-3" />
        </button>
      </div>

      {/* Actions (bottom) */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-zinc-950/80 border border-emerald-700/50 rounded px-1 py-1">
        <button
          tabIndex={-1}
          onClick={onCancel}
          className="px-2 py-0.5 text-xs flex items-center gap-1 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded transition-colors"
        >
          <X className="w-3 h-3" /> Cancel
        </button>
        <button
          tabIndex={-1}
          onClick={onRemove}
          className="px-2 py-0.5 text-xs flex items-center gap-1 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded transition-colors"
        >
          <Trash2 className="w-3 h-3" /> Remove
        </button>
        <button
          tabIndex={-1}
          onClick={handleApply}
          className="px-2 py-0.5 text-xs flex items-center gap-1 text-emerald-300 bg-emerald-500/15 hover:bg-emerald-500/25 rounded transition-colors"
        >
          <Check className="w-3 h-3" /> Apply
        </button>
      </div>
    </div>
  );
}
