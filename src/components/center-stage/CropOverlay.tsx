import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Check, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export type CropRatio = '16:9' | '9:16' | '1:1';

interface RectPx {
  x: number;
  y: number;
  w: number;
  h: number;
}

type CropMediaElement = HTMLVideoElement | HTMLImageElement;

interface CropOverlayProps {
  mediaRef: React.RefObject<CropMediaElement | null>;
  initialRatio: CropRatio;
  onApply: (ratio: CropRatio, rect: { x: number; y: number; w: number; h: number }) => void;
  onCancel: () => void;
}

function mediaIntrinsicSize(el: CropMediaElement): { w: number; h: number } {
  if (el instanceof HTMLVideoElement) {
    return { w: el.videoWidth, h: el.videoHeight };
  }
  return { w: el.naturalWidth, h: el.naturalHeight };
}

const RATIO_NUM: Record<CropRatio, number> = {
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '1:1': 1,
};

type DragMode =
  | { kind: 'move'; startPx: RectPx; startPointer: { x: number; y: number } }
  | { kind: 'resize'; corner: 'nw' | 'ne' | 'sw' | 'se'; anchor: { x: number; y: number } };

function computeContentRect(mediaEl: CropMediaElement | null): RectPx | null {
  if (!mediaEl) return null;
  const rect = mediaEl.getBoundingClientRect();
  const containerW = rect.width;
  const containerH = rect.height;
  if (containerW <= 0 || containerH <= 0) return null;

  const { w: mediaW, h: mediaH } = mediaIntrinsicSize(mediaEl);
  // Before metadata/decode loads, fall back to the bounding rect (no letterboxing assumed).
  if (!mediaW || !mediaH) {
    return { x: 0, y: 0, w: containerW, h: containerH };
  }

  const containerAspect = containerW / containerH;
  const mediaAspect = mediaW / mediaH;

  if (mediaAspect > containerAspect) {
    // Letterboxed: media fills width, bars on top/bottom.
    const renderedH = containerW / mediaAspect;
    return { x: 0, y: (containerH - renderedH) / 2, w: containerW, h: renderedH };
  }
  // Pillarboxed: media fills height, bars on left/right.
  const renderedW = containerH * mediaAspect;
  return { x: (containerW - renderedW) / 2, y: 0, w: renderedW, h: containerH };
}

function centeredRectForRatio(content: RectPx, ratio: CropRatio): RectPx {
  const aspect = RATIO_NUM[ratio];
  const fillW = content.w * 0.8;
  const fillH = content.h * 0.8;
  let w = fillW;
  let h = w / aspect;
  if (h > fillH) {
    h = fillH;
    w = h * aspect;
  }
  return {
    x: content.x + (content.w - w) / 2,
    y: content.y + (content.h - h) / 2,
    w,
    h,
  };
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
  ratio: CropRatio,
  content: RectPx,
): RectPx {
  const aspect = RATIO_NUM[ratio];
  const minSize = 24;
  const dx = pointer.x - anchor.x;
  const dy = pointer.y - anchor.y;

  // Keep at least minSize and the correct sign so the rect always has positive area.
  const signX = dx >= 0 ? 1 : -1;
  const signY = dy >= 0 ? 1 : -1;
  let aw = Math.max(Math.abs(dx), minSize);
  let ah = Math.max(Math.abs(dy), minSize);

  if (aw / ah > aspect) aw = ah * aspect;
  else ah = aw / aspect;

  // Clamp so the rect stays within the content rect.
  const maxW = signX > 0 ? content.x + content.w - anchor.x : anchor.x - content.x;
  const maxH = signY > 0 ? content.y + content.h - anchor.y : anchor.y - content.y;
  if (aw > maxW) {
    aw = Math.max(minSize, maxW);
    ah = aw / aspect;
  }
  if (ah > maxH) {
    ah = Math.max(minSize, maxH);
    aw = ah * aspect;
  }

  const x = signX > 0 ? anchor.x : anchor.x - aw;
  const y = signY > 0 ? anchor.y : anchor.y - ah;
  return { x, y, w: aw, h: ah };
}

const HANDLE_BASE =
  'absolute w-3 h-3 bg-white border border-zinc-900 shadow-md';

export function CropOverlay({ mediaRef, initialRatio, onApply, onCancel }: CropOverlayProps) {
  const [ratio, setRatio] = useState<CropRatio>(initialRatio);
  const [content, setContent] = useState<RectPx | null>(null);
  const [rectPx, setRectPx] = useState<RectPx | null>(null);
  const dragRef = useRef<DragMode | null>(null);
  const overlayRef = useRef<HTMLDivElement>(null);

  // Recompute content rect on mount, on media load/metadata, and on viewport resize.
  useEffect(() => {
    const mediaEl = mediaRef.current;
    if (!mediaEl) return;
    const recompute = () => setContent(computeContentRect(mediaEl));
    recompute();
    mediaEl.addEventListener('loadedmetadata', recompute);
    mediaEl.addEventListener('load', recompute);
    window.addEventListener('resize', recompute);
    const ro = new ResizeObserver(recompute);
    ro.observe(mediaEl);
    return () => {
      mediaEl.removeEventListener('loadedmetadata', recompute);
      mediaEl.removeEventListener('load', recompute);
      window.removeEventListener('resize', recompute);
      ro.disconnect();
    };
  }, [mediaRef]);

  // Place a fresh centered rectangle whenever the ratio changes or content rect first becomes available.
  useEffect(() => {
    if (!content) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setRectPx(centeredRectForRatio(content, ratio));
  }, [ratio, content]);

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
    // The "anchor" is the corner that stays fixed (the opposite corner from the dragged one).
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
      const next = clampRect({ ...drag.startPx, x: drag.startPx.x + dx, y: drag.startPx.y + dy }, content);
      setRectPx(next);
    } else {
      const next = resizeFromAnchor(drag.anchor, pointer, ratio, content);
      setRectPx(next);
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
    if (dragRef.current) {
      try { (e.currentTarget as Element).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      dragRef.current = null;
    }
  };

  const normalized = useMemo(() => {
    if (!rectPx || !content || content.w <= 0 || content.h <= 0) return null;
    return {
      x: Math.max(0, Math.min(1, (rectPx.x - content.x) / content.w)),
      y: Math.max(0, Math.min(1, (rectPx.y - content.y) / content.h)),
      w: Math.max(0, Math.min(1, rectPx.w / content.w)),
      h: Math.max(0, Math.min(1, rectPx.h / content.h)),
    };
  }, [rectPx, content]);

  const handleApply = () => {
    if (!normalized) return;
    onApply(ratio, normalized);
  };

  if (!content || !rectPx) {
    return (
      <div className="absolute inset-0 z-30 pointer-events-none" />
    );
  }

  // Mask uses four absolutely-positioned divs around rectPx.
  const maskTop = { left: 0, top: 0, width: '100%', height: rectPx.y };
  const maskBottom = { left: 0, top: rectPx.y + rectPx.h, width: '100%', bottom: 0 };
  const maskLeft = { left: 0, top: rectPx.y, width: rectPx.x, height: rectPx.h };
  const maskRight = { left: rectPx.x + rectPx.w, top: rectPx.y, right: 0, height: rectPx.h };

  return (
    <div
      ref={overlayRef}
      className="absolute inset-0 z-30 select-none"
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
    >
      {/* Dim mask outside the crop rect */}
      <div className="absolute bg-black/60 pointer-events-none" style={maskTop} />
      <div className="absolute bg-black/60 pointer-events-none" style={maskBottom} />
      <div className="absolute bg-black/60 pointer-events-none" style={maskLeft} />
      <div className="absolute bg-black/60 pointer-events-none" style={maskRight} />

      {/* Crop rectangle */}
      <div
        className="absolute border border-white/90 cursor-move"
        style={{ left: rectPx.x, top: rectPx.y, width: rectPx.w, height: rectPx.h }}
        onPointerDown={handleMoveStart}
      >
        {/* Rule-of-thirds guides */}
        <div className="absolute inset-0 pointer-events-none">
          <div className="absolute left-1/3 top-0 bottom-0 border-l border-white/20" />
          <div className="absolute left-2/3 top-0 bottom-0 border-l border-white/20" />
          <div className="absolute top-1/3 left-0 right-0 border-t border-white/20" />
          <div className="absolute top-2/3 left-0 right-0 border-t border-white/20" />
        </div>

        {/* Corner handles */}
        <div
          className={cn(HANDLE_BASE, 'cursor-nwse-resize')}
          style={{ left: -6, top: -6 }}
          onPointerDown={handleResizeStart('nw')}
        />
        <div
          className={cn(HANDLE_BASE, 'cursor-nesw-resize')}
          style={{ right: -6, top: -6 }}
          onPointerDown={handleResizeStart('ne')}
        />
        <div
          className={cn(HANDLE_BASE, 'cursor-nesw-resize')}
          style={{ left: -6, bottom: -6 }}
          onPointerDown={handleResizeStart('sw')}
        />
        <div
          className={cn(HANDLE_BASE, 'cursor-nwse-resize')}
          style={{ right: -6, bottom: -6 }}
          onPointerDown={handleResizeStart('se')}
        />
      </div>

      {/* Ratio toggle (top) */}
      <div className="absolute top-2 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-zinc-950/80 border border-zinc-700 rounded px-1 py-1">
        {(['16:9', '9:16', '1:1'] as CropRatio[]).map((r) => (
          <button
            key={r}
            tabIndex={-1}
            onClick={() => setRatio(r)}
            className={cn(
              'px-2 py-0.5 text-xs font-mono rounded transition-colors',
              r === ratio
                ? 'bg-primary/20 text-primary'
                : 'text-muted-foreground hover:text-primary hover:bg-primary/10',
            )}
          >
            {r}
          </button>
        ))}
      </div>

      {/* Apply / Cancel (bottom) */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 flex items-center gap-1 bg-zinc-950/80 border border-zinc-700 rounded px-1 py-1">
        <button
          tabIndex={-1}
          onClick={onCancel}
          className="px-2 py-0.5 text-xs flex items-center gap-1 text-muted-foreground hover:text-primary hover:bg-primary/10 rounded transition-colors"
        >
          <X className="w-3 h-3" />
          Cancel
        </button>
        <button
          tabIndex={-1}
          onClick={handleApply}
          className="px-2 py-0.5 text-xs flex items-center gap-1 text-primary bg-primary/15 hover:bg-primary/25 rounded transition-colors"
        >
          <Check className="w-3 h-3" />
          Apply
        </button>
      </div>
    </div>
  );
}
